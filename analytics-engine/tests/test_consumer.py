import pandas as pd
from unittest.mock import MagicMock, patch

from analytics_engine.consumer import (
    PingWindowBuffer,
    _BunchingEventTracker,
    _DeviationResultTracker,
    AnalyticsConsumer,
    WindowResult,
)
from metrics.bunching import BunchingEvent
from metrics.schedule_deviation import DeviationResult

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
    @patch("analytics_engine.consumer.GtfsStaticData")
    @patch("analytics_engine.consumer.find_close_pairs")
    @patch("analytics_engine.consumer.compute_arrival_deviations")
    @patch("analytics_engine.consumer.compute_departure_deviations")
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
    @patch("analytics_engine.consumer.GtfsStaticData")
    @patch("analytics_engine.consumer.find_close_pairs")
    @patch("analytics_engine.consumer.compute_arrival_deviations")
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
        with patch("analytics_engine.consumer.GtfsStaticData"):
            consumer = AnalyticsConsumer(kafka_config={"group.id": "test"}, topic="test", on_window_result=sink)

        consumer._process_window(pd.DataFrame())
        sink.assert_not_called()

    @patch("analytics_engine.consumer.GtfsStaticData")
    @patch("analytics_engine.consumer.find_close_pairs")
    @patch("analytics_engine.consumer.compute_arrival_deviations")
    @patch("analytics_engine.consumer.compute_departure_deviations")
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

    @patch("analytics_engine.consumer.GtfsStaticData")
    @patch("analytics_engine.consumer.find_close_pairs")
    @patch("analytics_engine.consumer.detect_bunching_events")
    @patch("analytics_engine.consumer.compute_arrival_deviations")
    @patch("analytics_engine.consumer.compute_departure_deviations")
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
