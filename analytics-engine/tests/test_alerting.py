"""
Unit tests for alerting.py (hardening-pass  ).

Rule 1 is the user-specified data alert: matched-ping ratio (the   counter)
below 50% sustained for 30 minutes. Rule 2: hourly deviations below X% of the
same hour in the previous week. The poller heartbeat lives in the ingestion
service and is tested there.
"""

from datetime import UTC, datetime, timedelta

from alerting import MIN_RATIO_SAMPLES, DataQualityAlerter, HealthcheckNotifier
from metrics.schedule_deviation import MatchingStats

BASE = datetime(2026, 11, 5, 12, 0, tzinfo=UTC)
PING_URL = "https://hc.test/ping/abc"


def ms(total: int, matched: int) -> MatchingStats:
    """MatchingStats with everything unmatched being lookup misses."""
    return MatchingStats(
        total_pings=total,
        matched_pings=matched,
        missing_field_pings=0,
        unmatched_pings=total - matched,
    )


def recording_notifier() -> tuple[HealthcheckNotifier, list[tuple[str, str]]]:
    calls: list[tuple[str, str]] = []
    notifier = HealthcheckNotifier(
        PING_URL, transport=lambda url, message: calls.append((url, message))
    )
    return notifier, calls


class TestHealthcheckNotifier:
    def test_ok_pings_the_plain_url(self):
        notifier, calls = recording_notifier()

        notifier.ok("all good")

        assert calls == [(PING_URL, "all good")]

    def test_fail_pings_the_fail_endpoint(self):
        notifier, calls = recording_notifier()

        notifier.fail("ratio collapsed")

        assert calls == [(PING_URL + "/fail", "ratio collapsed")]

    def test_disabled_without_url(self):
        calls = []
        transport = lambda url, message: calls.append((url, message))

        HealthcheckNotifier(None, transport=transport).ok()
        HealthcheckNotifier("", transport=transport).fail("x")

        assert calls == []

    def test_transport_failure_is_swallowed(self):
        def broken_transport(url: str, message: str) -> None:
            raise ConnectionError("healthchecks.io unreachable")

        notifier = HealthcheckNotifier(PING_URL, transport=broken_transport)

        notifier.ok()  # must not raise
        notifier.fail("x")  # must not raise

    def test_trailing_slash_is_stripped(self):
        notifier, calls = recording_notifier_url(PING_URL + "/")

        notifier.fail("x")

        assert calls == [(PING_URL + "/fail", "x")]


def recording_notifier_url(url: str):
    calls: list[tuple[str, str]] = []
    return (
        HealthcheckNotifier(url, transport=lambda u, m: calls.append((u, m))),
        calls,
    )


class TestMatchedRatioRule:
    """Rule 1: matched-ping ratio below 50% for 30 minutes."""

    def test_fires_after_30_sustained_minutes_and_not_before(self):
        notifier, calls = recording_notifier()
        alerter = DataQualityAlerter(notifier, deviation_count_between=lambda s, e: 0)

        for minute in range(30):  # 0..29 -> not yet a sustained 30 min
            alerter.observe_window(ms(100, 20), BASE + timedelta(minutes=minute))

        assert alerter.active_alerts() == []
        assert all(url == PING_URL for url, _ in calls)

        alerter.observe_window(ms(100, 20), BASE + timedelta(minutes=30))

        assert len(alerter.active_alerts()) == 1
        assert "matched-ping ratio" in alerter.active_alerts()[0]
        assert calls[-1][0] == PING_URL + "/fail"
        assert "matched-ping ratio" in calls[-1][1]

    def test_fires_with_realistic_window_cadence(self):
        """Regression: coverage must hold at real production cadence.

        Windows evaluate once per ~60s at arbitrary sub-second offsets
        (datetime.now()), so the oldest in-window sample is always slightly
        YOUNGER than the 30-minute cutoff. The old coverage check demanded
        the oldest trailing sample be >= 30 min old while the cutoff kept
        only samples <= 30 min old -- satisfied solely by an exact-boundary
        timestamp like the one the test above hand-crafts, and never in
        production (2026-11-08 healthcheck drill: 35 min pinned at 0%
        matched, no alert)."""
        notifier, calls = recording_notifier()
        alerter = DataQualityAlerter(notifier, deviation_count_between=lambda s, e: 0)

        jitter_seconds = [61.2, 62.9, 60.7, 63.1, 61.8]  # real flush cadence
        t = BASE + timedelta(seconds=0.318)

        for i in range(20):  # ~20 min of history: not yet sustained
            alerter.observe_window(ms(100, 0), t)
            t += timedelta(seconds=jitter_seconds[i % 5])
        assert alerter.active_alerts() == []  # < 30 min of history

        for i in range(12):  # -> ~32 min total, no boundary alignment
            alerter.observe_window(ms(100, 0), t)
            t += timedelta(seconds=jitter_seconds[i % 5])

        assert len(alerter.active_alerts()) == 1
        assert "matched-ping ratio" in alerter.active_alerts()[0]
        assert calls[-1][0] == PING_URL + "/fail"

    def test_fires_on_the_spec_threshold_boundary_only_below(self):
        """Exactly 50% is NOT 'below 50%'."""
        notifier, calls = recording_notifier()
        alerter = DataQualityAlerter(notifier, deviation_count_between=lambda s, e: 0)

        for minute in range(31):
            alerter.observe_window(ms(100, 50), BASE + timedelta(minutes=minute))

        assert alerter.active_alerts() == []
        assert calls[-1][0] == PING_URL

    def test_recovers_when_the_ratio_bounces_back(self):
        notifier, calls = recording_notifier()
        alerter = DataQualityAlerter(notifier, deviation_count_between=lambda s, e: 0)

        for minute in range(31):
            alerter.observe_window(ms(100, 10), BASE + timedelta(minutes=minute))
        assert alerter.active_alerts() != []

        for minute in range(31, 61):
            alerter.observe_window(ms(100, 95), BASE + timedelta(minutes=minute))

        assert alerter.active_alerts() == []
        assert calls[-1][0] == PING_URL  # plain ping again

    def test_judges_only_with_enough_samples(self):
        """Three sparse samples cannot certify a 30-minute window."""
        notifier, _ = recording_notifier()
        alerter = DataQualityAlerter(
            notifier,
            deviation_count_between=lambda s, e: 0,
            ratio_window_minutes=3,
        )

        # 3 samples spanning 3 minutes == minimum viable window.
        for minute in (0, 1, 2):
            alerter.observe_window(ms(100, 10), BASE + timedelta(minutes=minute))
        assert alerter.active_alerts() == []  # coverage only 2 min

        alerter.observe_window(ms(100, 10), BASE + timedelta(minutes=3))
        assert len(alerter.active_alerts()) == 1
        assert MIN_RATIO_SAMPLES == 3  # pinned: the guard this test exercises

    def test_empty_windows_are_not_judged_but_still_ping(self):
        notifier, calls = recording_notifier()
        alerter = DataQualityAlerter(notifier, deviation_count_between=lambda s, e: 0)

        alerter.observe_window(None, BASE)
        alerter.observe_window(MatchingStats(0, 0, 0, 0), BASE + timedelta(minutes=1))

        assert alerter.active_alerts() == []
        assert alerter.cumulative_matching == MatchingStats(0, 0, 0, 0)
        assert [url for url, _ in calls] == [PING_URL, PING_URL]

    def test_cumulative_counters_accumulate(self):
        notifier, _ = recording_notifier()
        alerter = DataQualityAlerter(notifier, deviation_count_between=lambda s, e: 0)

        alerter.observe_window(ms(100, 90), BASE)
        alerter.observe_window(ms(50, 40), BASE + timedelta(minutes=1))

        assert alerter.cumulative_matching.matched_pings == 130
        assert alerter.cumulative_matching.total_pings == 150


class TestDeviationVolumeRule:
    """Rule 2: hourly deviations below X% of the same hour last week."""

    HOUR = datetime(2026, 11, 5, 10, 0, tzinfo=UTC)
    WEEK_AGO = datetime(2026, 10, 29, 10, 0, tzinfo=UTC)

    @staticmethod
    def _counter(counts: dict[datetime, int]):
        return lambda start, end: counts[start]

    def _observe_two_hours(self, alerter, matching: MatchingStats | None = None):
        """One window inside hour 10, one inside hour 11 (closes hour 10)."""
        matching = matching if matching is not None else ms(100, 95)
        alerter.observe_window(matching, self.HOUR + timedelta(minutes=59))
        alerter.observe_window(matching, self.HOUR + timedelta(hours=1, minutes=1))

    def test_fires_when_the_hour_is_below_half_of_last_week(self):
        notifier, calls = recording_notifier()
        counts = {self.HOUR: 30, self.WEEK_AGO: 100}
        alerter = DataQualityAlerter(notifier, self._counter(counts))

        self._observe_two_hours(alerter)

        assert len(alerter.active_alerts()) == 1
        assert "hourly deviations" in alerter.active_alerts()[0]
        assert calls[-1][0] == PING_URL + "/fail"

    def test_does_not_fire_when_volume_is_healthy(self):
        notifier, calls = recording_notifier()
        counts = {self.HOUR: 80, self.WEEK_AGO: 100}
        alerter = DataQualityAlerter(notifier, self._counter(counts))

        self._observe_two_hours(alerter)

        assert alerter.active_alerts() == []
        assert calls[-1][0] == PING_URL

    def test_quiet_hours_are_not_judged(self):
        """3 vs 5 deviations is 60% -- and means nothing at that scale."""
        notifier, calls = recording_notifier()
        counts = {self.HOUR: 3, self.WEEK_AGO: 5}
        alerter = DataQualityAlerter(notifier, self._counter(counts))

        self._observe_two_hours(alerter)

        assert alerter.active_alerts() == []
        assert calls[-1][0] == PING_URL

    def test_query_failure_skips_the_hour_without_faking_an_alert(self):
        notifier, calls = recording_notifier()

        def broken_counter(start, end):
            raise RuntimeError("mongo down")

        alerter = DataQualityAlerter(notifier, broken_counter)

        self._observe_two_hours(alerter)

        assert alerter.active_alerts() == []
        assert calls[-1][0] == PING_URL

    def test_recovers_on_a_good_later_hour(self):
        notifier, calls = recording_notifier()
        counts = {
            self.HOUR: 30,
            self.WEEK_AGO: 100,
            self.HOUR + timedelta(hours=1): 90,
            self.WEEK_AGO + timedelta(hours=1): 100,
        }
        alerter = DataQualityAlerter(notifier, self._counter(counts))

        self._observe_two_hours(alerter)  # fires on hour 10
        assert alerter.active_alerts() != []

        # Next hour rolls over and looks healthy -> recovery.
        alerter.observe_window(ms(100, 95), self.HOUR + timedelta(hours=2, minutes=1))

        assert alerter.active_alerts() == []
        assert calls[-1][0] == PING_URL

    def test_alert_message_carries_both_reasons_when_both_fire(self):
        notifier, calls = recording_notifier()
        counts = {self.HOUR: 10, self.WEEK_AGO: 100}
        alerter = DataQualityAlerter(notifier, self._counter(counts))

        # Bad ratio long enough to fire rule 1, then hour rollover fires rule 2.
        for minute in range(31):
            alerter.observe_window(ms(100, 10), self.HOUR + timedelta(minutes=minute))
        alerter.observe_window(ms(100, 10), self.HOUR + timedelta(hours=1, minutes=1))

        assert len(alerter.active_alerts()) == 2
        fail_message = calls[-1][1]
        assert "matched-ping ratio" in fail_message
        assert "hourly deviations" in fail_message
