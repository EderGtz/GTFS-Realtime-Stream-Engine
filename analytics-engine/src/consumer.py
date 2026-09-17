"""
consumer.py

Live consumer which wires together raw.vehicle-positions telemetry, GTFS-static lookups
(gtfs_static/loader.py), and both metrics modules (schedule_deviation.py, bunching.py).

WINDOWING STRATEGY EXPLANATION: TIME-WINDOWED WITH OVERLAP
================================================
The notebooks operated on one fully-collected DataFrame, which was recolected in a limited
amount of time. A live consumer, like this is supposed to work, has to decide how to batch 
streaming pings before either metrics module (both expect a DataFrame, not a single message), 
and this choice directly affects correctness, beside implementation convenience.

Two alternatives were considered and rejected due their implications:

- Pure time-windowed with no overlap: accumulate pings for WINDOW_SECONDS, process,
  discard, repeat. This is a simple alternative, but it could actively break bunching's 
  persistence check. A real bunching event that starts near the end of one window and 
  continues into the next gets its observations split across two batches, and neither 
  of them may contain enough consecutive observations on its own to cross the 
  MIN_CONSECUTIVE_OBSERVATIONS. So, a genuine sustained event can be silently missed 
  entirely at the boundary.

- Count-windowed: accumulate until N amount messages arrive. Adapts to fleet-size changes
  (rush hour vs. late night), but doesn't fix the boundary problem above at all,
  it's still a hard cut, just triggered by count instead of time. It could also produce
  delayed results depending on the time the information is recolected.

The strategy chosen is WINDOWED WITH OVERLAP, which actually fixes the missed-event problem: 
each window's PROCESSING data is the last OVERLAP_SECONDS of the previous window's pings, plus 
all of this window's new pings. A boundary-crossing event is now visible in full, in whichever
window has accumulated enough of it to cross the persistence threshold.

But the overlap alone created a brand new problem: since the overlapping pings get reprocessed,
an event that was already fully detected using the overlap-extended window can
easily still be sitting inside the CARRY-FORWARD buffer for the window after that
too, and this wold cause a re-run detect_bunching_events over the same observations, which can cause
that the identical event is emitted a second time, as if it were new.

This was fixed with a small in-memory dedup/update layer (_BunchingEventTracker below), keyed
by (route_id, direction_id, vehicle_a, vehicle_b):

- Never seen before                     -> emit as a new event, cache it.

- Seen before, end_time unchanged       -> already fully emitted; skip.

- Seen before, end_time grew            -> the event is still ongoing across
                                            windows; emit as an UPDATE (same
                                            identity, extended end_time), not a
                                            duplicate new row.

Schedule deviation doesn't need the "growing update" half of this: first-arrival
collapsing is idempotent (recomputing over the same or a superset of pings always
yields the same first/last observation), so a plain dedup-by-key
(vehicle_id, trip_id, stop_sequence, kind) is enough there. Take a look at
_DeviationResultTracker.

Known limitation, not fixed here: this scheme assumes

    `OVERLAP_SECONDS >= MIN_CONSECUTIVE_OBSERVATIONS * POLL_INTERVAL_SECONDS`

For example, the overlap is at least as long as the minimum span a real bunching event needs
to qualify at all. If OVERLAP_SECONDS is configured smaller than that, a boundary
event could still be missed the same way the no-overlap case would. The default
below (OVERLAP_SECONDS=30) is exactly 2x bunching's own MIN_CONSECUTIVE_OBSERVATIONS
* POLL_INTERVAL_SECONDS (2 * 15 = 30), which is the minimum safe value, not one with
extra margin. This would be worth revisiting with real production data the same way every other
threshold in this project was (notebook 04's sensitivity sweep, notebook 01's
incident-fraction threshold), rather than just treated it as a final decition.
"""
from __future__ import annotations

import json
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

import pandas as pd
from confluent_kafka import Consumer, KafkaException

from db.writer import PersistWindowResult
from gtfs_static.loader import GtfsStaticData
from gtfs_static.refresh import download_and_extract_gtfs
from metrics.bunching import (
    MIN_CONSECUTIVE_OBSERVATIONS,
    POLL_INTERVAL_SECONDS,
    BunchingEvent,
    detect_bunching_events,
    find_close_pairs,
)
from metrics.schedule_deviation import (
    DeviationResult,
    compute_arrival_deviations,
    compute_departure_deviations,
    to_eastern,
)
from utils.logger import get_logger

logger = get_logger("analytics-engine.consumer")

WINDOW_SECONDS = 60
OVERLAP_SECONDS = MIN_CONSECUTIVE_OBSERVATIONS * POLL_INTERVAL_SECONDS

# How long a dedup/tracker entry is kept before being purged, bounding memory growth
# for a long-running process. Generous relative to OVERLAP_SECONDS since an event
# that's still actively growing across many windows should keep being recognized as
# an update, not start looking "new" again once its cache entry ages out too early.
TRACKER_RETENTION_SECONDS = WINDOW_SECONDS * 10

GTFS_REFRESH_INTERVAL_SECONDS = 24 * 60 * 60  # matches the "recurring interval" spec


class PingWindowBuffer:
    """
    Accumulates incoming pings and produces the (carry-forward + new data) batch
    each window should be processed against. Take a look at the the windowing 
    strategy in this module's docstring for why the carry-forward exists.
    """

    def __init__(self, overlap_seconds: int = OVERLAP_SECONDS):
        self.overlap_seconds = overlap_seconds
        self._rows: list[dict] = []

    def add(self, ping: dict) -> None:
        self._rows.append(ping)

    def flush(self) -> pd.DataFrame:
        """
        Return the full batch for this window (carry-forward + everything added
        since the last flush), and reset internal state to carry forward only the
        last `overlap_seconds` of it for the next window.
        """
        if not self._rows:
            return pd.DataFrame()

        df = pd.DataFrame(self._rows)
        # The ingestion service publishes `timestamp` in UTC.  The metrics
        # modules need an Eastern-timezone column, so we create it here.
        df["timestamp_eastern"] = df["timestamp"].apply(to_eastern)

        cutoff = df["timestamp_eastern"].max() - pd.Timedelta(seconds=self.overlap_seconds)
        carry_forward = df[df["timestamp_eastern"] >= cutoff]
        self._rows = carry_forward.to_dict("records")

        return df

class _BunchingEventTracker:
    """
    Dedup/update layer for bunching events. See module docstring for why
    overlap alone isn't sufficient without this.
    """

    def __init__(self, retention_seconds: int = TRACKER_RETENTION_SECONDS):
        self.retention_seconds = retention_seconds
        self._last_seen: dict[tuple, BunchingEvent] = {}

    def _key(self, event: BunchingEvent) -> tuple:
        return (
            event.route_id, 
            event.direction_id, 
            event.vehicle_a, 
            event.vehicle_b,
            )

    def reconcile(
            self, 
            events: list[BunchingEvent],
            reference_time: pd.Timestamp,
        ) -> list[tuple[str, BunchingEvent]]:
        """
        Returns [(action, event), ...] where action is "new" or "update".
        The event key identifies the vehicle pair; temporal continuity determines
        whether a new detection is a continuation of a previously tracked event.
        """
        actions: list[tuple[str, BunchingEvent]] = []

        for event in events:
            key = self._key(event)
            previous = self._last_seen.get(key)

            if previous is None:
                actions.append(("new", event))
                self._last_seen[key] = event
                continue

            is_continuation = (
                event.start_time
                <= previous.end_time
                + pd.Timedelta(seconds=POLL_INTERVAL_SECONDS)
            )

            if is_continuation and event.end_time > previous.end_time:
                updated_event = BunchingEvent(
                    route_id=event.route_id,
                    direction_id=event.direction_id,
                    vehicle_a=event.vehicle_a,
                    vehicle_b=event.vehicle_b,
                    start_time=min(previous.start_time, event.start_time),
                    end_time=event.end_time,
                    observation_count=event.observation_count,
                    min_distance_meters=min(previous.min_distance_meters, event.min_distance_meters),
                )

                actions.append(("update", updated_event))
                self._last_seen[key] = updated_event

            elif not is_continuation:
                actions.append(("new", event))
                self._last_seen[key] = event

        self._purge_stale(reference_time)
        return actions

    def _purge_stale(self, reference_time: pd.Timestamp) -> None:
        cutoff = reference_time - pd.Timedelta(seconds=self.retention_seconds)

        self._last_seen = {
            key: event
            for key, event in self._last_seen.items()
            if event.end_time >= cutoff
        }


class _DeviationResultTracker:
    """
    Dedup layer for schedule deviation results. Simpler than the bunching tracker:
    first-arrival/last-departure collapsing is idempotent, so a plain seen-before
    check on (vehicle_id, trip_id, stop_sequence, kind) is enough, and no "growing
    update" case exists here the way it does for bunching's persistence runs.
    """

    def __init__(self, retention_seconds: int = TRACKER_RETENTION_SECONDS):
        self.retention_seconds = retention_seconds
        self._seen: dict[tuple, pd.Timestamp] = {}

    def _key(self, result: DeviationResult) -> tuple:
        return (result.vehicle_id, result.trip_id, result.stop_sequence, result.kind)

    def filter_new(
        self,
        results: list[DeviationResult],
        reference_time: pd.Timestamp,
    ) -> list[DeviationResult]:
        fresh = []
        for result in results:
            key = self._key(result)
            if key not in self._seen:
                fresh.append(result)
                self._seen[key] = result.actual_at

        cutoff = reference_time - pd.Timedelta(seconds=self.retention_seconds)
        self._seen = {
            key: timestamp
            for key, timestamp in self._seen.items()
            if timestamp >= cutoff
        }

        return fresh


@dataclass
class WindowResult:
    bunching_actions: list[tuple[str, BunchingEvent]]
    new_deviations: list[DeviationResult]


class AnalyticsConsumer:
    """
    Consumes raw.vehicle-positions, batches via PingWindowBuffer, and computes both
    metrics per window using GtfsStaticData's lookups. Refreshed periodically per
    the README's Phase 3 spec, not on every window (that would mean re-parsing
    MBTA's full static bundle, hundreds of thousands of rows, every 60 seconds).

    Output is handed to `on_window_result`, a pluggable callback since db/writer.py
    doesn't exist yet, so this stays a callback rather than a hardcoded Mongo write.
    """

    def __init__(
        self,
        kafka_config: dict,
        topic: str,
        gtfs_dir: Path | str | None = None,
        on_window_result: Callable[[WindowResult], PersistWindowResult] | None = None,
        window_seconds: int = WINDOW_SECONDS,
        gtfs_refresh_interval_seconds: int = GTFS_REFRESH_INTERVAL_SECONDS,
        retry_base_seconds: float = 1.0,
        retry_max_seconds: float = 60.0,
        retry_jitter_seconds: float = 1.0,
    ):
        self.consumer = Consumer(kafka_config)
        self.topic = topic
        self.window_seconds = window_seconds
        self.on_window_result = on_window_result or self._default_sink

        self.static_data = GtfsStaticData(gtfs_dir) if gtfs_dir else GtfsStaticData()
        self._gtfs_dir = gtfs_dir  # stored for refresh.download_and_extract_gtfs
        self.static_data.load()
        self._gtfs_refresh_interval = gtfs_refresh_interval_seconds
        self._last_gtfs_refresh_check = time.time()

        self.buffer = PingWindowBuffer()
        self.bunching_tracker = _BunchingEventTracker()
        self.deviation_tracker = _DeviationResultTracker()

        # Exponential backoff state for MongoDB persist failures.
        # When persist fails, the consumer enters a backoff period during
        # which it continues polling Kafka (maintaining the consumer group)
        # but skips the persist attempt. The delay increases exponentially
        # up to retry_max_seconds, with jitter to avoid thundering herd.
        self._retry_base_seconds = retry_base_seconds
        self._retry_max_seconds = retry_max_seconds
        self._retry_jitter_seconds = retry_jitter_seconds
        self._consecutive_failures = 0
        self._backoff_until = 0.0

    def _default_sink(self, result: WindowResult) -> dict[str, bool]:
        logger.info(
            "Window produced %d bunching action(s), %d new deviation result(s)",
            len(result.bunching_actions), len(result.new_deviations),
        )
        return {"success": True}

    def _in_backoff(self) -> bool:
        return time.time() < self._backoff_until

    def _enter_backoff(self) -> None:
        delay = min(
            self._retry_max_seconds,
            self._retry_base_seconds * (2 ** self._consecutive_failures),
        )
        delay += random.uniform(0, self._retry_jitter_seconds)
        self._backoff_until = time.time() + delay
        self._consecutive_failures += 1
        logger.warning(
            "MongoDB persist failed (attempt %d). Backing off for %.1fs before retry.",
            self._consecutive_failures, delay,
        )

    def _reset_backoff(self) -> None:
        if self._consecutive_failures > 0:
            logger.info(
                "MongoDB persist recovered after %d failure(s). Resetting backoff.",
                self._consecutive_failures,
            )
        self._consecutive_failures = 0
        self._backoff_until = 0.0

    def _maybe_refresh_gtfs_static(self) -> None:
        now = time.time()
        if now - self._last_gtfs_refresh_check < self._gtfs_refresh_interval:
            return
        self._last_gtfs_refresh_check = now

        try:
            # Step 1: fetch the latest ZIP from MBTA if the remote changed.
            download_kwargs: dict = {}
            if self._gtfs_dir is not None:
                download_kwargs["target_dir"] = self._gtfs_dir
            print("refres.py called")
            download_and_extract_gtfs(**download_kwargs)

            # Step 2: reload lookups if the on-disk files actually changed
            # (either from the download above, or a manual replacement).
            reloaded = self.static_data.reload_if_changed()
            if reloaded:
                logger.info("GTFS-static bundle changed, reloaded lookups.")
        except (FileNotFoundError, ValueError) as err:
            # Atomic-replace design in loader.py means the previous, valid
            # snapshot is untouched. Logged and keep serving it rather than
            # crashing the whole consumer over one bad refresh attempt.
            logger.error("GTFS-static refresh failed, continuing with previous snapshot: %s", err)

    def _enrich_with_location(
        self, deviations: list[DeviationResult]
    ) -> list[DeviationResult]:
        """Attach GeoJSON location to deviation results using stop coordinates
        from the GTFS-static data. The stop_id comes from stop_times_lookup,
        and the actual lat/lon from stops_lookup. Silently skips enrichment
        when either lookup fails (e.g. stop not in stops.txt), so the
        deviation is still emitted -- just without a location field."""
        enriched: list[DeviationResult] = []
        for dev in deviations:
            scheduled = self.static_data.stop_times_lookup.get(
                (dev.trip_id, dev.stop_sequence)
            )
            if scheduled is None or scheduled.stop_id is None:
                enriched.append(dev)
                continue

            stop_info = self.static_data.stops_lookup.get(scheduled.stop_id)
            if stop_info is None or stop_info.stop_lat is None or stop_info.stop_lon is None:
                enriched.append(dev)
                continue

            location = {
                "type": "Point",
                "coordinates": [stop_info.stop_lon, stop_info.stop_lat],
            }
            enriched.append(replace(dev, location=location))

        return enriched

    def _process_window(
            self, 
            pings: pd.DataFrame
        ) -> PersistWindowResult | dict[str, bool] | None:
        
        if pings.empty:
            return None
        reference_time = pings["timestamp_eastern"].max()

        # Extract flat lat/lon from the GeoJSON `location` field the ingestion
        # service publishes.  GeoJSON coordinates are [longitude, latitude].
        if "location" in pings.columns:
            pings = pings.copy()
            pings["lat"] = pings["location"].apply(
                lambda loc: loc["coordinates"][1] if isinstance(loc, dict) and "coordinates" in loc else None
            )
            pings["lon"] = pings["location"].apply(
                lambda loc: loc["coordinates"][0] if isinstance(loc, dict) and "coordinates" in loc else None
            )

        scoped = pings[pings["stop_id"].notna()].copy()  # notebook 02, Section C

        try:
            close_pairs = find_close_pairs(pings, self.static_data.direction_lookup)
            bunching_events = detect_bunching_events(close_pairs)

            bunching_actions = self.bunching_tracker.reconcile(
                bunching_events,
                reference_time,
            )
            
        except Exception:
            logger.exception("Bunching computation failed for this window, skipping it.")
            bunching_actions = []

        try:
            arrival_results = compute_arrival_deviations(scoped, self.static_data.stop_times_lookup)
            departure_results = compute_departure_deviations(scoped, self.static_data.stop_times_lookup)
            new_deviations = self.deviation_tracker.filter_new(
                arrival_results + departure_results,
                reference_time,
            )
            new_deviations = self._enrich_with_location(new_deviations)
        except Exception:
            logger.exception("Schedule-deviation computation failed for this window, skipping it.")
            new_deviations = []

        return self.on_window_result(
            WindowResult(
                bunching_actions=bunching_actions, 
                new_deviations=new_deviations
                )
            )

    def run(self) -> None:
        self.consumer.subscribe([self.topic])
        logger.info(
            "Consumer started on topic '%s', window=%ds, overlap=%ds",
            self.topic, 
            self.window_seconds, 
            self.buffer.overlap_seconds
        )

        last_window_flush = time.time()

        try:
            while True:
                msg = self.consumer.poll(timeout=1.0)

                if msg is not None:
                    if msg.error():
                        raise KafkaException(msg.error())

                    value = msg.value()

                    if value is None:
                        logger.warning("Skipping Kafka message with no value")
                        continue

                    try:
                        self.buffer.add(json.loads(value.decode("utf-8")))
                    except (json.JSONDecodeError, KeyError, UnicodeDecodeError):
                        logger.warning("Skipping malformed message.")
                        continue

                self._maybe_refresh_gtfs_static()

                if time.time() - last_window_flush >= self.window_seconds:
                    window_pings = self.buffer.flush()

                    if self._in_backoff():
                        logger.debug("In backoff, skipping persist attempt.")
                        last_window_flush = time.time()
                        continue

                    persist_result = self._process_window(window_pings)

                    if persist_result is not None:
                        if persist_result.get("success"):
                            self.consumer.commit(asynchronous=False)
                            self._reset_backoff()
                        else:
                            self._enter_backoff()

                    last_window_flush = time.time()

        finally:
            self.consumer.close()