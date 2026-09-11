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
    def test_process_window_error_handling(self, mock_arr, mock_pairs, MockGtfs):
        """
        If a metrics module crashes, the consumer should catch it, log it, 
        and call the callback with empty lists, avoiding a fatal crash.
        """
        sink = MagicMock()
        
        # Initialize Consumer with dummy Kafka config and mock static data
        consumer = AnalyticsConsumer(
            kafka_config={"group.id": "test"}, 
            topic="test", 
            on_window_result=sink
        )
        
        # Force bunching to crash
        mock_pairs.side_effect = Exception("Bunching Engine Failure")
        mock_arr.return_value = []
        
        # Create a dummy window DataFrame
        df = pd.DataFrame([
            {"stop_id": "1", "timestamp_eastern": ets("2026-08-18 10:00:00")}
        ])
        
        # Process the window
        consumer._process_window(df)
        
        # The sink should have been called EXACTLY ONCE
        assert sink.call_count == 1
        
        # Inspect what was sent to the sink
        result: WindowResult = sink.call_args[0][0]
        assert result.bunching_actions == [] # Handled gracefully!
        assert isinstance(result.new_deviations, list)