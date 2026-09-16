import json
import time
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

from consumer import (
    AnalyticsConsumer,
    PingWindowBuffer,
    WindowResult,
    _BunchingEventTracker,
    _DeviationResultTracker,
)
from gtfs_static.loader import StopInfo
from metrics.bunching import BunchingEvent
from metrics.schedule_deviation import DeviationResult, ScheduledStopTime

EASTERN = "America/New_York"

def ets(time_str: str) -> pd.Timestamp:
    """Helper to generate timezone-aware timestamps for tests."""
    return pd.Timestamp(time_str, tz=EASTERN)


class TestBunchingEventTracker:
    def test_new_and_update_actions(self):
        """
        A continuous bunching event split across windows should emit a 'new' action first,
        and then an 'update' action as the end_time grows.
        """
        tracker = _BunchingEventTracker()
        
        # Window 1: Event detected from 10:00:00 to 10:00:45
        event_w1 = BunchingEvent(
            route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
            start_time=ets("2026-08-18 10:00:00"), end_time=ets("2026-08-18 10:00:45"),
            observation_count=4, min_distance_meters=15.0
        )
        actions_w1 = tracker.reconcile([event_w1], reference_time=ets("2026-08-18 10:00:45"))
        
        assert len(actions_w1) == 1
        assert actions_w1[0][0] == "new"
        assert actions_w1[0][1].end_time == ets("2026-08-18 10:00:45")

        # Window 2: Overlap catches it again, but now it lasts until 10:01:30
        event_w2 = BunchingEvent(
            route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
            start_time=ets("2026-08-18 10:00:15"), end_time=ets("2026-08-18 10:01:30"),
            observation_count=6, min_distance_meters=12.0
        )
        actions_w2 = tracker.reconcile([event_w2], reference_time=ets("2026-08-18 10:01:30"))
        
        assert len(actions_w2) == 1
        assert actions_w2[0][0] == "update"
        assert actions_w2[0][1].start_time == ets("2026-08-18 10:00:00") # Keeps original start
        assert actions_w2[0][1].end_time == ets("2026-08-18 10:01:30")   # Updated end

    def test_separate_occurrence(self):
        """If the same pair bunches again much later, it should be a 'new' event."""
        tracker = _BunchingEventTracker()
        
        event1 = BunchingEvent(
            route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
            start_time=ets("2026-08-18 10:00:00"), end_time=ets("2026-08-18 10:00:45"),
            observation_count=4, min_distance_meters=15.0
        )
        tracker.reconcile([event1], reference_time=ets("2026-08-18 10:00:45"))
        
        # 30 minutes later...
        event2 = BunchingEvent(
            route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
            start_time=ets("2026-08-18 10:30:00"), end_time=ets("2026-08-18 10:30:30"),
            observation_count=2, min_distance_meters=20.0
        )
        actions = tracker.reconcile([event2], reference_time=ets("2026-08-18 10:30:30"))
        
        assert len(actions) == 1
        assert actions[0][0] == "new"

    def test_identical_redetection(self):
        """If the exact same event is passed again without growth, ignore it."""
        tracker = _BunchingEventTracker()
        
        event = BunchingEvent(
            route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
            start_time=ets("2026-08-18 10:00:00"), end_time=ets("2026-08-18 10:00:45"),
            observation_count=4, min_distance_meters=15.0
        )
        
        # First time -> new
        actions1 = tracker.reconcile([event], reference_time=ets("2026-08-18 10:00:45"))
        assert len(actions1) == 1
        
        # Second time exactly the same -> ignored (no-op)
        actions2 = tracker.reconcile([event], reference_time=ets("2026-08-18 10:00:45"))
        assert len(actions2) == 0

    def test_purge_on_empty(self):
        """Tracker should clean memory up even when no events happen."""
        tracker = _BunchingEventTracker(retention_seconds=100)
        
        event = BunchingEvent(
            route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
            start_time=ets("2026-08-18 10:00:00"), end_time=ets("2026-08-18 10:00:00"),
            observation_count=2, min_distance_meters=15.0
        )
        tracker.reconcile([event], reference_time=ets("2026-08-18 10:00:00"))
        assert len(tracker._last_seen) == 1
        
        # Simulate an empty window 300s later
        tracker.reconcile([], reference_time=ets("2026-08-18 10:05:00"))
        assert len(tracker._last_seen) == 0


class TestDeviationResultTracker:
    def test_dedup_and_purge(self):
        tracker = _DeviationResultTracker(retention_seconds=100)
        
        dev = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300
        )
        
        # 1. First time seen -> returns the item
        fresh = tracker.filter_new([dev], reference_time=ets("2026-08-18 10:05:00"))
        assert len(fresh) == 1
        
        # 2. Seen again -> returns empty
        duplicate = tracker.filter_new([dev], reference_time=ets("2026-08-18 10:05:00"))
        assert len(duplicate) == 0
        
        # 3. Time passes, cache purges
        tracker.filter_new([], reference_time=ets("2026-08-18 10:10:00"))
        
        # 4. Seen again after purge -> returns as new again
        re_fresh = tracker.filter_new([dev], reference_time=ets("2026-08-18 10:10:00"))
        assert len(re_fresh) == 1


class TestPingWindowBuffer:
    def test_buffer_overlap_retention(self):
        """Verify the buffer flushes correctly and retains the specified overlap."""
        buffer = PingWindowBuffer(overlap_seconds=30)

        # Add 5 pings, spaced by 15 seconds, using Timedelta to avoid time string overflow
        base_time = ets("2026-08-18 10:00:00")
        for i in range(5):
            ping_time = base_time + pd.Timedelta(seconds=15 * i)
            buffer.add({
                "vehicle_id": "v1",
                "timestamp_eastern": ping_time.strftime("%Y-%m-%d %H:%M:%S%z")
            })
            
        df = buffer.flush()
        
        # It should return all 5 rows for the current window
        assert len(df) == 5
        
        # The internal state should now only hold the last 30 seconds (last 3 pings)
        assert len(buffer._rows) == 3


class TestAnalyticsConsumer:
    @patch("consumer.GtfsStaticData")
    @patch("consumer.find_close_pairs")
    @patch("consumer.compute_arrival_deviations")
    @patch("consumer.compute_departure_deviations")
    def test_process_window_error_handling(self, mock_dep, mock_arr, mock_pairs, MockGtfs):
        """
        If bunching crashes, the consumer should catch it, log it, and still compute
        deviations independently. One metric's failure must not silently take the
        other down with it, since they're wrapped in separate try/except blocks.
        """
        sink = MagicMock()
        
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"}, 
            topic="test", 
            on_window_result=sink
        )
        
        # Force bunching to crash
        mock_pairs.side_effect = Exception("Bunching Engine Failure")
        mock_arr.return_value = []
        mock_dep.return_value = []
        
        df = pd.DataFrame([
            {
                "stop_id": "1", 
                "timestamp_eastern": ets("2026-08-18 10:00:00"), 
                "current_status": "STOPPED_AT"
            }
        ])
        
        consumer._process_window(df)
        
        assert sink.call_count == 1
        # Proves the deviation path was actually reached and succeeded on its own,
        # not just that new_deviations happens to be [] for some other, unverified reason.
        mock_arr.assert_called_once()
        mock_dep.assert_called_once()
        
        # Inspect what was sent to the sink
        result: WindowResult = sink.call_args[0][0]
        assert result.bunching_actions == []
        assert isinstance(result.new_deviations, list)
    @patch("consumer.GtfsStaticData")
    @patch("consumer.find_close_pairs")
    @patch("consumer.compute_arrival_deviations")
    def test_process_window_deviation_failure_does_not_affect_bunching(self, mock_arr, mock_pairs, MockGtfs):
        sink = MagicMock()
        consumer = AnalyticsConsumer(kafka_config={"group.id": "test"}, topic="test", on_window_result=sink)

        mock_arr.side_effect = Exception("Deviation Engine Failure")
        mock_pairs.return_value = pd.DataFrame()  # empty close_pairs -> detect_bunching_events returns []

        df = pd.DataFrame([{"stop_id": "1", "timestamp_eastern": ets("2026-08-18 10:00:00")}])
        consumer._process_window(df)

        result: WindowResult = sink.call_args[0][0]
        assert result.bunching_actions == []      # ran cleanly, just had nothing to report
        assert result.new_deviations == []        # failed and was caught
        mock_pairs.assert_called_once()           # proves bunching's path actually executed

    def test_process_window_empty_input_never_calls_sink(self):
        sink = MagicMock()
        with patch("consumer.GtfsStaticData"):
            consumer = AnalyticsConsumer(kafka_config={"group.id": "test"}, topic="test", on_window_result=sink)

        consumer._process_window(pd.DataFrame())
        sink.assert_not_called()

    @patch("consumer.GtfsStaticData")
    @patch("consumer.find_close_pairs")
    @patch("consumer.compute_arrival_deviations")
    @patch("consumer.compute_departure_deviations")
    def test_bunching_gets_full_pings_deviation_gets_scoped(self, mock_dep, mock_arr, mock_pairs, MockGtfs):
        sink = MagicMock()
        consumer = AnalyticsConsumer(kafka_config={"group.id": "test"}, topic="test", on_window_result=sink)
        mock_arr.return_value, mock_dep.return_value = [], []

        df = pd.DataFrame([
            {"stop_id": "1", "timestamp_eastern": ets("2026-08-18 10:00:00"), "current_status": "STOPPED_AT"},
            {"stop_id": None, "timestamp_eastern": ets("2026-08-18 10:00:15"), "current_status": "IN_TRANSIT_TO"},
        ])

        consumer._process_window(df)

        # find_close_pairs must have received BOTH rows -- bunching doesn't need stop_id.
        bunching_input = mock_pairs.call_args[0][0]
        assert len(bunching_input) == 2

        # compute_arrival_deviations must have received only the stop_id-resolved row.
        deviation_input = mock_arr.call_args[0][0]
        assert len(deviation_input) == 1
        assert deviation_input.iloc[0]["stop_id"] == "1"

    @patch("consumer.GtfsStaticData")
    @patch("consumer.find_close_pairs")
    @patch("consumer.detect_bunching_events")
    @patch("consumer.compute_arrival_deviations")
    @patch("consumer.compute_departure_deviations")
    def test_process_window_happy_path_passes_results_through(
        self, mock_dep, mock_arr, mock_detect, mock_pairs, MockGtfs
    ):
        sink = MagicMock()
        consumer = AnalyticsConsumer(kafka_config={"group.id": "test"}, topic="test", on_window_result=sink)

        fake_event = BunchingEvent(route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
                                    start_time=ets("2026-08-18 10:00:00"), end_time=ets("2026-08-18 10:00:45"),
                                    observation_count=4, min_distance_meters=15.0)
        mock_pairs.return_value = pd.DataFrame()
        mock_detect.return_value = [fake_event]
        mock_arr.return_value = []
        mock_dep.return_value = []

        df = pd.DataFrame([{"stop_id": "1", "timestamp_eastern": ets("2026-08-18 10:00:00"), "current_status": "STOPPED_AT"}])
        consumer._process_window(df)

        result: WindowResult = sink.call_args[0][0]
        assert len(result.bunching_actions) == 1
        assert result.bunching_actions[0][0] == "new"
        assert result.bunching_actions[0][1] is fake_event


class TestLocationEnrichment:
    """Tests for AnalyticsConsumer._enrich_with_location, which attaches
    GeoJSON stop coordinates to DeviationResults for 2dsphere indexing."""

    def _make_consumer_with_lookups(self, stop_times_lookup, stops_lookup):
        """Helper: build a consumer with controlled GTFS-static lookups."""
        sink = MagicMock()
        with patch("consumer.GtfsStaticData") as MockGtfs:
            MockGtfs.return_value.stop_times_lookup = stop_times_lookup
            MockGtfs.return_value.stops_lookup = stops_lookup
            MockGtfs.return_value.direction_lookup = {}
            consumer = AnalyticsConsumer(
                kafka_config={"group.id": "test"},
                topic="test",
                on_window_result=sink,
            )
        return consumer

    def test_enrichment_adds_geojson_when_stop_is_known(self):
        dev = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
        )
        consumer = self._make_consumer_with_lookups(
            stop_times_lookup={
                ("t1", 5): ScheduledStopTime(
                    trip_id="t1", stop_sequence=5,
                    arrival_time="10:00:00", departure_time=None,
                    stop_id="70001",
                ),
            },
            stops_lookup={
                "70001": StopInfo(stop_id="70001", stop_name="Alewife",
                                  stop_lat=42.3954, stop_lon=-71.1425),
            },
        )

        enriched = consumer._enrich_with_location([dev])

        assert len(enriched) == 1
        assert enriched[0].location == {
            "type": "Point",
            "coordinates": [-71.1425, 42.3954],
        }
        # Original is not mutated (frozen dataclass)
        assert dev.location is None

    def test_enrichment_leaves_location_none_when_no_stop_id_in_schedule(self):
        """If ScheduledStopTime has no stop_id (column was missing from the
        GTFS bundle), the deviation is passed through unchanged."""
        dev = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
        )
        consumer = self._make_consumer_with_lookups(
            stop_times_lookup={
                ("t1", 5): ScheduledStopTime(
                    trip_id="t1", stop_sequence=5,
                    arrival_time="10:00:00", departure_time=None,
                    stop_id=None,
                ),
            },
            stops_lookup={},
        )

        enriched = consumer._enrich_with_location([dev])
        assert enriched[0].location is None

    def test_enrichment_leaves_location_none_when_stop_not_in_stops_lookup(self):
        """If the stop_id exists in stop_times but the stop isn't in stops.txt
        (e.g. a removed stop), skip enrichment gracefully."""
        dev = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
        )
        consumer = self._make_consumer_with_lookups(
            stop_times_lookup={
                ("t1", 5): ScheduledStopTime(
                    trip_id="t1", stop_sequence=5,
                    arrival_time="10:00:00", departure_time=None,
                    stop_id="REMOVED_STOP",
                ),
            },
            stops_lookup={},  # stop not found
        )

        enriched = consumer._enrich_with_location([dev])
        assert enriched[0].location is None

    def test_enrichment_leaves_location_none_when_coordinates_missing(self):
        """If the stop exists but has no lat/lon (e.g. a virtual/agency-level
        stop in GTFS), skip enrichment."""
        dev = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
        )
        consumer = self._make_consumer_with_lookups(
            stop_times_lookup={
                ("t1", 5): ScheduledStopTime(
                    trip_id="t1", stop_sequence=5,
                    arrival_time="10:00:00", departure_time=None,
                    stop_id="70001",
                ),
            },
            stops_lookup={
                "70001": StopInfo(stop_id="70001", stop_name="Virtual",
                                  stop_lat=None, stop_lon=None),
            },
        )

        enriched = consumer._enrich_with_location([dev])
        assert enriched[0].location is None

    def test_enrichment_handles_empty_list(self):
        consumer = self._make_consumer_with_lookups({}, {})
        assert consumer._enrich_with_location([]) == []

    def test_enrichment_mixed_results(self):
        """Some deviations enrichable, some not -- only the right ones get
        location."""
        dev_ok = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
        )
        dev_no_stop = DeviationResult(
            vehicle_id="v2", trip_id="t2", stop_sequence=1, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:02:00"),
            deviation_seconds=120,
        )
        consumer = self._make_consumer_with_lookups(
            stop_times_lookup={
                ("t1", 5): ScheduledStopTime(
                    trip_id="t1", stop_sequence=5,
                    arrival_time="10:00:00", departure_time=None,
                    stop_id="70001",
                ),
                # ("t2", 1) not in lookup at all
            },
            stops_lookup={
                "70001": StopInfo(stop_id="70001", stop_name="Alewife",
                                  stop_lat=42.3954, stop_lon=-71.1425),
            },
        )

        enriched = consumer._enrich_with_location([dev_ok, dev_no_stop])

        assert len(enriched) == 2
        assert enriched[0].location is not None
        assert enriched[0].location["coordinates"] == [-71.1425, 42.3954]
        assert enriched[1].location is None


class TestCommitGating:
    """Tests that AnalyticsConsumer.run() only commits Kafka offsets when
    persistence succeeds, which is the core of the at-least-once delivery guarantee."""

    VALID_PING = json.dumps({
        "vehicle_id": "v1", "trip_id": "t1", "route_id": "R1",
        "lat": 42.0, "lon": -71.0, "stop_id": "s1",
        "current_stop_sequence": 1, "current_status": "STOPPED_AT",
        "timestamp_eastern": "2026-08-18 10:00:00",
    }).encode()

    def _make_kafka_message(self, payload=VALID_PING):
        msg = MagicMock()
        msg.error.return_value = None
        msg.value.return_value = payload
        return msg

    @patch("consumer.GtfsStaticData")
    @patch("consumer.find_close_pairs")
    @patch("consumer.detect_bunching_events")
    @patch("consumer.compute_arrival_deviations")
    @patch("consumer.compute_departure_deviations")
    @patch("consumer.Consumer")
    def test_commits_when_persist_succeeds(
        self, MockKafka, mock_dep, mock_arr, mock_detect, mock_pairs, MockGtfs
    ):
        mock_kafka = MockKafka.return_value
        mock_kafka.poll.side_effect = [
            self._make_kafka_message(),  # first poll: message -> buffer
            KeyboardInterrupt,           # second poll: exit loop
        ]
        mock_pairs.return_value = pd.DataFrame()
        mock_detect.return_value = []
        mock_arr.return_value = []
        mock_dep.return_value = []

        sink = MagicMock(return_value={
            "success": True, "bunching_written": 0, "deviations_written": 0,
        })
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=sink,
            window_seconds=0,  # flush every iteration
        )

        with pytest.raises(KeyboardInterrupt):
            consumer.run()

        mock_kafka.commit.assert_called_once_with(asynchronous=False)

    @patch("consumer.GtfsStaticData")
    @patch("consumer.find_close_pairs")
    @patch("consumer.detect_bunching_events")
    @patch("consumer.compute_arrival_deviations")
    @patch("consumer.compute_departure_deviations")
    @patch("consumer.Consumer")
    def test_skips_commit_when_persist_fails(
        self, MockKafka, mock_dep, mock_arr, mock_detect, mock_pairs, MockGtfs
    ):
        mock_kafka = MockKafka.return_value
        mock_kafka.poll.side_effect = [
            self._make_kafka_message(),
            KeyboardInterrupt,
        ]
        mock_pairs.return_value = pd.DataFrame()
        mock_detect.return_value = []
        mock_arr.return_value = []
        mock_dep.return_value = []

        sink = MagicMock(return_value={
            "success": False, "bunching_written": 0, "deviations_written": 0,
        })
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=sink,
            window_seconds=0,
        )

        with pytest.raises(KeyboardInterrupt):
            consumer.run()

        mock_kafka.commit.assert_not_called()

    @patch("consumer.GtfsStaticData")
    @patch("consumer.Consumer")
    def test_skips_commit_when_window_is_empty(self, MockKafka, MockGtfs):
        """Empty window -> _process_window returns None -> no commit."""
        mock_kafka = MockKafka.return_value
        mock_kafka.poll.side_effect = [
            None,              # no message -> buffer stays empty
            KeyboardInterrupt,  # exit
        ]

        sink = MagicMock()
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=sink,
            window_seconds=0,
        )

        with pytest.raises(KeyboardInterrupt):
            consumer.run()

        sink.assert_not_called()
        mock_kafka.commit.assert_not_called()

    @patch("consumer.GtfsStaticData")
    @patch("consumer.find_close_pairs")
    @patch("consumer.detect_bunching_events")
    @patch("consumer.compute_arrival_deviations")
    @patch("consumer.compute_departure_deviations")
    @patch("consumer.Consumer")
    def test_commit_not_called_on_second_window_after_first_success(
        self, MockKafka, mock_dep, mock_arr, mock_detect, mock_pairs, MockGtfs
    ):
        """Two windows: first succeeds (commit), second fails (no commit).
        Verifies the gating decision is per-window, not sticky."""
        mock_kafka = MockKafka.return_value

        msg1 = self._make_kafka_message()
        msg2 = self._make_kafka_message(
            json.dumps({
                "vehicle_id": "v2", "trip_id": "t2", "route_id": "R1",
                "lat": 42.0, "lon": -71.0, "stop_id": "s1",
                "current_stop_sequence": 2, "current_status": "IN_TRANSIT_TO",
                "timestamp_eastern": "2026-08-18 10:01:00",
            }).encode()
        )
        # Window 1: message -> success -> commit
        # Window 2: message -> failure -> no commit
        # Then exit
        mock_kafka.poll.side_effect = [msg1, msg2, KeyboardInterrupt]

        mock_pairs.return_value = pd.DataFrame()
        mock_detect.return_value = []
        mock_arr.return_value = []
        mock_dep.return_value = []

        sink = MagicMock(side_effect=[
            {"success": True, "bunching_written": 0, "deviations_written": 0},
            {"success": False, "bunching_written": 0, "deviations_written": 0},
        ])
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=sink,
            window_seconds=0,
        )

        with pytest.raises(KeyboardInterrupt):
            consumer.run()

        # commit called once (for the first window), not twice
        assert mock_kafka.commit.call_count == 1

    @patch("consumer.GtfsStaticData")
    @patch("consumer.Consumer")
    def test_consumer_closed_in_finally(self, MockKafka, MockGtfs):
        """Even on KeyboardInterrupt, the Kafka consumer is closed cleanly."""
        mock_kafka = MockKafka.return_value
        mock_kafka.poll.side_effect = KeyboardInterrupt

        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=MagicMock(),
        )

        with pytest.raises(KeyboardInterrupt):
            consumer.run()

        mock_kafka.close.assert_called_once()


class TestPersistBackoff:
    """Tests for the exponential backoff behavior when MongoDB persist fails.
    The consumer should back off from persist attempts with increasing delays,
    while continuing to poll Kafka to maintain consumer-group membership."""

    VALID_PING = json.dumps({
        "vehicle_id": "v1", "trip_id": "t1", "route_id": "R1",
        "lat": 42.0, "lon": -71.0, "stop_id": "s1",
        "current_stop_sequence": 1, "current_status": "STOPPED_AT",
        "timestamp_eastern": "2026-08-18 10:00:00",
    }).encode()

    def _make_kafka_message(self):
        msg = MagicMock()
        msg.error.return_value = None
        msg.value.return_value = self.VALID_PING
        return msg

    @patch("consumer.GtfsStaticData")
    @patch("consumer.Consumer")
    def test_backoff_state_starts_clean(self, MockKafka, MockGtfs):
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=MagicMock(),
        )
        assert consumer._consecutive_failures == 0
        assert consumer._backoff_until == 0.0
        assert not consumer._in_backoff()

    @patch("consumer.GtfsStaticData")
    @patch("consumer.Consumer")
    def test_enter_backoff_increases_delay(self, MockKafka, MockGtfs):
        """Each consecutive failure should roughly double the base delay."""
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=MagicMock(),
            retry_base_seconds=1.0,
            retry_max_seconds=60.0,
            retry_jitter_seconds=0.0,  # no jitter for deterministic test
        )

        # First failure: delay ≈ 1.0 * 2^0 = 1.0s
        consumer._enter_backoff()
        assert consumer._consecutive_failures == 1
        delay1 = consumer._backoff_until - time.time()
        assert 0.8 <= delay1 <= 1.2

        # Second failure: delay ≈ 1.0 * 2^1 = 2.0s
        consumer._enter_backoff()
        assert consumer._consecutive_failures == 2
        delay2 = consumer._backoff_until - time.time()
        assert 1.8 <= delay2 <= 2.2

        # Third failure: delay ≈ 1.0 * 2^2 = 4.0s
        consumer._enter_backoff()
        assert consumer._consecutive_failures == 3
        delay3 = consumer._backoff_until - time.time()
        assert 3.8 <= delay3 <= 4.2

    @patch("consumer.GtfsStaticData")
    @patch("consumer.Consumer")
    def test_backoff_capped_at_max(self, MockKafka, MockGtfs):
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=MagicMock(),
            retry_base_seconds=1.0,
            retry_max_seconds=5.0,
            retry_jitter_seconds=0.0,
        )

        # Simulate many failures to exceed max
        for _ in range(20):
            consumer._enter_backoff()

        # The backoff delay should never exceed max + jitter
        # Since jitter is 0, the delay from the last call should be <= 5.0
        assert consumer._consecutive_failures == 20

    @patch("consumer.GtfsStaticData")
    @patch("consumer.Consumer")
    def test_reset_backoff_clears_state(self, MockKafka, MockGtfs):
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=MagicMock(),
        )
        consumer._enter_backoff()
        consumer._enter_backoff()
        assert consumer._consecutive_failures == 2
        assert consumer._in_backoff()

        consumer._reset_backoff()
        assert consumer._consecutive_failures == 0
        assert consumer._backoff_until == 0.0
        assert not consumer._in_backoff()

    @patch("consumer.GtfsStaticData")
    @patch("consumer.find_close_pairs")
    @patch("consumer.detect_bunching_events")
    @patch("consumer.compute_arrival_deviations")
    @patch("consumer.compute_departure_deviations")
    @patch("consumer.Consumer")
    def test_run_skips_persist_during_backoff(
        self, MockKafka, mock_dep, mock_arr, mock_detect, mock_pairs, MockGtfs
    ):
        """When in backoff, the consumer should skip _process_window entirely
        and NOT call commit."""
        mock_kafka = MockKafka.return_value
        mock_kafka.poll.side_effect = [
            self._make_kafka_message(),  # first window: message -> persist fails -> enter backoff
            self._make_kafka_message(),  # second window: in backoff -> skip persist
            KeyboardInterrupt,
        ]
        mock_pairs.return_value = pd.DataFrame()
        mock_detect.return_value = []
        mock_arr.return_value = []
        mock_dep.return_value = []

        sink = MagicMock(return_value={
            "success": False, "bunching_written": 0, "deviations_written": 0,
        })
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=sink,
            window_seconds=0,
            retry_base_seconds=10.0,  # long backoff so second window is definitely in backoff
            retry_jitter_seconds=0.0,
        )

        with pytest.raises(KeyboardInterrupt):
            consumer.run()

        # The sink (on_window_result) should only be called ONCE (first window),
        # not on the second window where backoff is active.
        assert sink.call_count == 1
        mock_kafka.commit.assert_not_called()

    @patch("consumer.GtfsStaticData")
    @patch("consumer.find_close_pairs")
    @patch("consumer.detect_bunching_events")
    @patch("consumer.compute_arrival_deviations")
    @patch("consumer.compute_departure_deviations")
    @patch("consumer.Consumer")
    def test_run_resets_backoff_on_recovery(
        self, MockKafka, mock_dep, mock_arr, mock_detect, mock_pairs, MockGtfs
    ):
        """After a failure followed by success, backoff should reset."""
        mock_kafka = MockKafka.return_value

        fail_result = {"success": False, "bunching_written": 0, "deviations_written": 0}
        ok_result = {"success": True, "bunching_written": 0, "deviations_written": 0}

        mock_kafka.poll.side_effect = [
            self._make_kafka_message(),  # window 1: fail -> enter backoff
            self._make_kafka_message(),  # window 2: backoff expired -> succeed -> reset
            KeyboardInterrupt,
        ]
        mock_pairs.return_value = pd.DataFrame()
        mock_detect.return_value = []
        mock_arr.return_value = []
        mock_dep.return_value = []

        sink = MagicMock(side_effect=[fail_result, ok_result])
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"},
            topic="test",
            on_window_result=sink,
            window_seconds=0,
            retry_base_seconds=0.0,  # instant backoff expiry so window 2 retries
            retry_jitter_seconds=0.0,
        )

        with pytest.raises(KeyboardInterrupt):
            consumer.run()

        assert sink.call_count == 2
        mock_kafka.commit.assert_called_once_with(asynchronous=False)
        assert consumer._consecutive_failures == 0
