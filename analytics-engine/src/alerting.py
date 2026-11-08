"""
alerting.py — data-level health alerts

On Nov 1-2 2026 the poller was healthy while the
analytics matching stage silently dropped nearly every ping (stale active-
service filter + a DST gate bug). A poller-only heartbeat would have stayed
green the whole time. These alerts watch the DATA, not the processes:

1. Matched-ping ratio (the   counter from metrics/schedule_deviation.py)
   below 50% sustained for 30 minutes -> the schedule-matching stage is
   dropping live traffic (the exact Nov 2 signature).
2. Hourly deviation volume below X% (default 50%) of the same hour in the
   previous week -> output has collapsed relative to a comparable baseline
   (the exact Nov 1 signature, where matching looked fine but the ±30-min
   gate rejected everything). Low-volume hours (fewer than
   DEVIATION_VOLUME_MIN_WEEK_AGO deviations a week ago) are skipped: a ratio
   over tiny counts is noise, not signal.

The poller heartbeat (ingestion-service healthcheck.ts) is kept as-is — it is
cheap and it is the right tool for "the process stopped pinging". Together the
three signals cover: process death (heartbeat), matching collapse (rule 1),
and output collapse (rule 2).

Alert delivery: Healthchecks.io-style endpoints (HealthcheckNotifier). The
notifier is pinged on EVERY window evaluation — plain ping while healthy,
`/fail` while any rule is firing — so the same check doubles as a dead-man's
switch for the analytics engine itself. Thresholds are module constants on
purpose: they are design knobs to reason about (and tune with real data), not
deployment values.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from datetime import datetime, timedelta

import requests

from metrics.schedule_deviation import MatchingStats
from utils.logger import get_logger

logger = get_logger("analytics-engine.alerting")

# Rule 1 — matched-ping ratio.
MATCHED_RATIO_THRESHOLD = 0.5
MATCHED_RATIO_WINDOW_MINUTES = 30

# Rule 2 — hourly deviation volume vs the same hour last week. "X%" was left
# open in the plan; 50% is chosen to mirror rule 1: on Nov 2 the pipeline ran
# at 25-45% of a normal day, so 50% catches the incident class with margin
# while staying quiet on ordinary day-to-day variance.
DEVIATION_VOLUME_MIN_RATIO = 0.5
# Hours whose week-ago count is below this are not judged at all (a drop from
# 3 to 1 deviations is 33% and means nothing).
DEVIATION_VOLUME_MIN_WEEK_AGO = 20

# Rule 1 aggregation guards.
MIN_RATIO_SAMPLES = 3  # never judge a "30-minute" window on 1-2 samples
SAMPLE_RETENTION_MINUTES = MATCHED_RATIO_WINDOW_MINUTES + 10

PING_TIMEOUT_SECONDS = 5.0


class HealthcheckNotifier:
    """
    Fire-and-forget pings to a Healthchecks.io-style endpoint.

    Semantics: a plain POST to the check URL reports "ok" (with the message as
    the request body, shown in Healthchecks.io's ping log); POST to `<url>/fail`
    marks the check DOWN immediately. Transport failure isolation is absolute:
    a failed ping is logged and swallowed, because alerting must never be able
    to break the pipeline it watches.

    `url=None` or `""` disables the notifier (local runs without a check). An
    injectable `transport(url, message)` keeps the class testable without HTTP.
    """

    def __init__(
        self,
        url: str | None,
        timeout_seconds: float = PING_TIMEOUT_SECONDS,
        transport: Callable[[str, str], None] | None = None,
    ):
        self.url = url.rstrip("/") if url else None
        self.timeout_seconds = timeout_seconds
        self._transport = transport or self._http_transport

    def _http_transport(self, url: str, message: str) -> None:
        requests.post(url, data=message.encode("utf-8"), timeout=self.timeout_seconds)

    def _ping(self, path: str, message: str) -> None:
        if not self.url:
            return
        target = self.url + path
        try:
            self._transport(target, message)
        except Exception as err:  # noqa: BLE001 — see docstring: never propagate
            logger.warning("Healthcheck ping to %s failed: %s", target, err)

    def ok(self, message: str = "") -> None:
        self._ping("", message)

    def fail(self, message: str) -> None:
        self._ping("/fail", message)


class DataQualityAlerter:
    """
    Evaluates the two data-level rules on every processed window and keeps the
    HealthcheckNotifier's ping carrying the current aggregate state.

    Driven by the analytics consumer's on_window_result callback (main.py):

        alerter.observe_window(result.matching, now)

    Window-cadence pings also make this a dead-man's switch: if processing
    stops entirely, pings stop and the check itself alerts.

    `deviation_count_between(start, end)` is injected (main.py binds it to
    MetricsWriter.count_deviations_between) so the weekly comparison is
    testable without MongoDB.
    """

    def __init__(
        self,
        notifier: HealthcheckNotifier,
        deviation_count_between: Callable[[datetime, datetime], int],
        *,
        matched_ratio_threshold: float = MATCHED_RATIO_THRESHOLD,
        ratio_window_minutes: int = MATCHED_RATIO_WINDOW_MINUTES,
        deviation_min_ratio: float = DEVIATION_VOLUME_MIN_RATIO,
        week_ago_min_count: int = DEVIATION_VOLUME_MIN_WEEK_AGO,
    ):
        self.notifier = notifier
        self.deviation_count_between = deviation_count_between
        self.matched_ratio_threshold = matched_ratio_threshold
        self.ratio_window_minutes = ratio_window_minutes
        self.deviation_min_ratio = deviation_min_ratio
        self.week_ago_min_count = week_ago_min_count

        # (observed_at, matched_pings, total_pings) per window.
        self._ratio_samples: deque[tuple[datetime, int, int]] = deque()
        self._cumulative = MatchingStats(0, 0, 0, 0)
        self._current_hour: datetime | None = None

        self._ratio_reason: str | None = None
        self._volume_reason: str | None = None

    # --- public API ---

    def observe_window(self, matching: MatchingStats | None, now: datetime) -> None:
        """Feed one processed window into the rules. `now` is injectable for
        tests but is the wall-clock UTC time in production."""
        if matching is not None and matching.total_pings > 0:
            self._cumulative = self._cumulative + matching
            self._ratio_samples.append(
                (now, matching.matched_pings, matching.total_pings)
            )
            self._prune_ratio_samples(now)

        self._maybe_close_hour(now)
        self._evaluate_ratio_rule(now)
        self._ping_state()

    @property
    def cumulative_matching(self) -> MatchingStats:
        """Running   totals since process start (for pipeline_status)."""
        return self._cumulative

    def active_alerts(self) -> list[str]:
        """Human-readable reasons for every firing rule (for pipeline_status)."""
        return [
            reason
            for reason in (self._ratio_reason, self._volume_reason)
            if reason is not None
        ]

    # --- rule 1: matched-ping ratio ---

    def _prune_ratio_samples(self, now: datetime) -> None:
        retention = timedelta(minutes=SAMPLE_RETENTION_MINUTES)
        while self._ratio_samples and self._ratio_samples[0][0] < now - retention:
            self._ratio_samples.popleft()

    def _evaluate_ratio_rule(self, now: datetime) -> None:
        cutoff = now - timedelta(minutes=self.ratio_window_minutes)
        trailing = [s for s in self._ratio_samples if s[0] >= cutoff]
        if len(trailing) < MIN_RATIO_SAMPLES:
            return  # not enough information to judge; leave state untouched

        if self._ratio_samples[0][0] > cutoff:
            return

        total = sum(total for _, _, total in trailing)
        matched = sum(matched for _, matched, _ in trailing)
        ratio = matched / total if total else None
        if ratio is None:
            return

        if ratio < self.matched_ratio_threshold:
            reason = (
                f"matched-ping ratio {ratio:.0%} below "
                f"{self.matched_ratio_threshold:.0%} for "
                f"{self.ratio_window_minutes} min "
                f"({matched}/{total} pings matched)"
            )
            if self._ratio_reason is None:
                logger.error("DATA ALERT: %s", reason)
            self._ratio_reason = reason
        elif self._ratio_reason is not None:
            logger.info(
                "DATA ALERT recovered: matched-ping ratio back to %.0f%%.", ratio * 100
            )
            self._ratio_reason = None

    # --- rule 2: deviation volume vs the same hour last week ---

    def _maybe_close_hour(self, now: datetime) -> None:
        hour = now.replace(minute=0, second=0, microsecond=0)
        if self._current_hour is None:
            self._current_hour = hour
            return
        if hour <= self._current_hour:
            return
        completed_hour = self._current_hour
        self._current_hour = hour
        self._evaluate_volume_rule(completed_hour)

    def _evaluate_volume_rule(self, completed_hour: datetime) -> None:
        week_ago_hour = completed_hour - timedelta(days=7)
        try:
            current = self.deviation_count_between(
                completed_hour, completed_hour + timedelta(hours=1)
            )
            week_ago = self.deviation_count_between(
                week_ago_hour, week_ago_hour + timedelta(hours=1)
            )
        except Exception:  # a query failure must not fake an alert
            logger.exception(
                "Deviation-volume check could not query counts; skipping hour %s.",
                completed_hour.isoformat(),
            )
            return

        if week_ago < self.week_ago_min_count:
            # Quiet hour (night service, Sunday morning...): a ratio over tiny
            # counts is noise. Not judged — and an already-firing state is left
            # untouched until a judgeable hour comes along.
            return

        ratio = current / week_ago
        if ratio < self.deviation_min_ratio:
            reason = (
                f"hourly deviations {current} = {ratio:.0%} of the same hour "
                f"last week ({week_ago}), below {self.deviation_min_ratio:.0%} "
                f"({completed_hour.isoformat()})"
            )
            if self._volume_reason is None:
                logger.error("DATA ALERT: %s", reason)
            self._volume_reason = reason
        elif self._volume_reason is not None:
            logger.info(
                "DATA ALERT recovered: hourly deviation volume back to %.0f%% "
                "of the same hour last week.",
                ratio * 100,
            )
            self._volume_reason = None

    # --- notifier cadence ---

    def _ping_state(self) -> None:
        reasons = self.active_alerts()
        if reasons:
            self.notifier.fail("; ".join(reasons))
        else:
            self.notifier.ok()
