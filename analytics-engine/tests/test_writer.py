import pandas as pd
import pytest
from unittest.mock import MagicMock, call, patch, Mock
from pymongo import ASCENDING, UpdateOne
from pymongo.errors import PyMongoError

from db.writer import (
    build_bunching_operations,
    build_deviation_operations,
    MetricsWriter,
    _connect_with_retry,
)
from metrics.bunching import BunchingEvent
from metrics.schedule_deviation import DeviationResult

EASTERN = "America/New_York"

def ets(time_str: str) -> pd.Timestamp:
    """Helper to generate timezone-aware timestamps for tests."""
    return pd.Timestamp(time_str, tz=EASTERN)


class TestPureOperationBuilders:
    """
    Test the pure functions that convert domain events into PyMongo UpdateOne operations.
    No live MongoDB connection required.
    """

    def test_build_bunching_operations(self):
        event = BunchingEvent(
            route_id="57", direction_id=1, vehicle_a="y3227", vehicle_b="y3280",
            start_time=ets("2026-09-01 20:16:30"), end_time=ets("2026-09-01 20:45:45"),
            observation_count=13, min_distance_meters=15.5
        )
        
        # Test both "new" and "update" actions
        actions = [("new", event), ("update", event)]
        ops = build_bunching_operations(actions)
        
        assert len(ops) == 2
        for i, op in enumerate(ops):
            assert isinstance(op, UpdateOne)
            assert op._upsert is True
            
            # 1. Check the natural key (the filter)
            expected_key = {
                "route_id": "57",
                "direction_id": 1,
                "vehicle_a": "y3227",
                "vehicle_b": "y3280",
                "start_time": event.start_time.to_pydatetime(), # Must be native datetime
            }
            assert op._filter == expected_key
            
            # 2. Check the payload ($set)
            document = op._doc["$set"]
            assert document["end_time"] == event.end_time.to_pydatetime()
            assert document["observation_count"] == 13
            assert document["min_distance_meters"] == 15.5
            assert document["last_action"] == actions[i][0]

    def test_build_deviation_operations(self):
        result = DeviationResult(
            vehicle_id="1700", trip_id="NorthBase-77", stop_sequence=10, kind="arrival",
            scheduled_at=ets("2026-09-01 19:15:00"), actual_at=ets("2026-09-01 19:17:40"),
            deviation_seconds=160.0
        )
        
        ops = build_deviation_operations([result])
        assert len(ops) == 1
        
        op = ops[0]
        assert isinstance(op, UpdateOne)
        assert op._upsert is True
        
        expected_key = {
            "vehicle_id": "1700",
            "trip_id": "NorthBase-77",
            "stop_sequence": 10,
            "kind": "arrival",
        }
        assert op._filter == expected_key
        assert op._doc["$set"]["deviation_seconds"] == 160.0
        assert op._doc["$set"]["actual_at"] == result.actual_at.to_pydatetime()


class TestMetricsWriterIO:
    """
    Test the MetricsWriter class using mocks to simulate MongoDB behavior.
    """

    @patch("db.writer._connect_with_retry")
    def test_writer_initialization_ensures_indexes(self, mock_connect):
        """Verifies that initializing the writer automatically sets up the unique indexes."""
        mock_client = MagicMock()
        mock_connect.return_value = mock_client
        
        writer = MetricsWriter(mongo_uri="mongodb://fake")
        
        # Verify indexes were created on the correct collections with the correct keys
        bunching_col = mock_client["gtfs_realtime"]["bunching_events"]
        bunching_col.create_index.assert_any_call(
            [("route_id", ASCENDING), ("direction_id", ASCENDING),
             ("vehicle_a", ASCENDING), ("vehicle_b", ASCENDING), ("start_time", ASCENDING)],
            unique=True,
            name="bunching_natural_key"
        )
        
        deviation_col = mock_client["gtfs_realtime"]["schedule_deviations"]
        deviation_col.create_index.assert_any_call(
            [("vehicle_id", ASCENDING), ("trip_id", ASCENDING),
             ("stop_sequence", ASCENDING), ("kind", ASCENDING)],
            unique=True,
            name="deviation_natural_key"
        )

    @patch("db.writer._connect_with_retry")
    @patch("db.writer.build_bunching_operations")
    def test_write_bunching_actions_success(self, mock_build, mock_connect):
        """Verifies bulk_write is called with ordered=False and counts are returned."""
        mock_client = MagicMock()
        mock_connect.return_value = mock_client
        
        # Setup mock operations and bulk_write result
        mock_build.return_value = ["op1", "op2"]
        mock_bulk_result = MagicMock()
        mock_bulk_result.upserted_count = 1
        mock_bulk_result.modified_count = 1
        mock_client["gtfs_realtime"]["bunching_events"].bulk_write.return_value = mock_bulk_result
        
        writer = MetricsWriter(mongo_uri="mongodb://fake")
        
        # Execute
        total_processed = writer.write_bunching_actions([("fake_action", MagicMock())])
        
        # Assertions
        assert total_processed == 2
        writer.bunching_collection.bulk_write.assert_called_once_with(["op1", "op2"], ordered=False)

    @patch("db.writer._connect_with_retry")
    def test_write_empty_lists_are_noop(self, mock_connect):
        """Verifies that empty lists return 0 immediately without hitting the DB."""
        mock_client = MagicMock()
        mock_connect.return_value = mock_client
        writer = MetricsWriter(mongo_uri="mongodb://fake")
        
        assert writer.write_bunching_actions([]) == 0
        assert writer.write_deviation_results([]) == 0
        
        # bulk_write should NEVER be called
        writer.bunching_collection.bulk_write.assert_not_called()
        writer.deviation_collection.bulk_write.assert_not_called()

    @patch("db.writer._connect_with_retry")
    @patch("db.writer.build_deviation_operations")
    def test_write_catches_pymongo_error(self, mock_build, mock_connect):
        """Verifies that DB failures are caught and logged, preventing consumer crashes."""
        mock_client = MagicMock()
        mock_connect.return_value = mock_client
        mock_build.return_value = ["op1"]
        
        # Force a PyMongoError
        mock_client["gtfs_realtime"]["schedule_deviations"].bulk_write.side_effect = PyMongoError("DB Down")
        
        writer = MetricsWriter(mongo_uri="mongodb://fake")
        
        # Should return 0 instead of crashing
        total = writer.write_deviation_results([MagicMock()])
        assert total == 0


class TestConnectWithRetry:
    @patch("db.writer.time.sleep")
    @patch("db.writer.MongoClient")
    def test_connect_retries_and_fails(self, mock_mongo, mock_sleep):
        """Verifies the retry loop exhausts attempts and raises ConnectionError."""
        # Force the ping command to fail every time
        mock_client_instance = MagicMock()
        mock_client_instance.admin.command.side_effect = PyMongoError("Timeout")
        mock_mongo.return_value = mock_client_instance
        
        with pytest.raises(ConnectionError, match="Could not connect to MongoDB after 3 attempts"):
            _connect_with_retry("mongodb://fake", attempts=3, delay_seconds=0.1)
            
        assert mock_client_instance.admin.command.call_count == 3
        assert mock_sleep.call_count == 2 # Sleeps between attempts, not after the last one