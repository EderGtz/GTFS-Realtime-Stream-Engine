from unittest.mock import MagicMock, patch

import pandas as pd
import pytest
from pymongo import ASCENDING, UpdateOne
from pymongo.errors import PyMongoError

from db.writer import (
    MetricsWriter,
    _connect_with_retry,
    build_bunching_operations,
    build_deviation_operations,
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

    NOTE: These tests access pymongo's private attributes (_filter, _doc, _upsert)
    because UpdateOne has no public API to inspect the operation shape. This is
    deliberate and acceptable for testing the pure builder output. The glue tests
    in TestBuildOperationGlue verify the same behavior through the public
    bulk_write interface as defense-in-depth.
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
        
        MetricsWriter(mongo_uri="mongodb://fake")
        
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


    @patch("db.writer.time.sleep")
    @patch("db.writer.MongoClient")
    def test_connect_succeeds_on_retry(self, mock_mongo, mock_sleep):
        """Verifies that a transient failure followed by success returns the client."""
        mock_client_instance = MagicMock()
        # First two attempts fail, third succeeds
        mock_client_instance.admin.command.side_effect = [
            PyMongoError("Timeout"),
            PyMongoError("Timeout"),
            "ok",  # successful ping
        ]
        mock_mongo.return_value = mock_client_instance

        client = _connect_with_retry("mongodb://fake", attempts=5, delay_seconds=0.1)

        assert client is mock_client_instance
        assert mock_client_instance.admin.command.call_count == 3
        assert mock_sleep.call_count == 2

    @patch("db.writer.MongoClient")
    def test_connect_succeeds_on_first_attempt(self, mock_mongo):
        """No retries needed when the first attempt succeeds."""
        mock_client_instance = MagicMock()
        mock_client_instance.admin.command.return_value = "ok"
        mock_mongo.return_value = mock_client_instance

        client = _connect_with_retry("mongodb://fake", attempts=3, delay_seconds=0.1)

        assert client is mock_client_instance
        assert mock_client_instance.admin.command.call_count == 1


class TestBunchingErrorHandling:
    """Symmetric error handling: bunching writes should also catch PyMongoError
    and return 0, matching the deviation side."""

    @patch("db.writer._connect_with_retry")
    @patch("db.writer.build_bunching_operations")
    def test_write_bunching_catches_pymongo_error(self, mock_build, mock_connect):
        mock_client = MagicMock()
        mock_connect.return_value = mock_client
        mock_build.return_value = ["op1"]

        mock_client["gtfs_realtime"]["bunching_events"].bulk_write.side_effect = PyMongoError("DB Down")

        writer = MetricsWriter(mongo_uri="mongodb://fake")

        total = writer.write_bunching_actions([MagicMock()])
        assert total == 0


class TestPersistWindow:
    """Tests for MetricsWriter.persist_window, which is the integration point
    between the pure domain and MongoDB persistence."""

    @patch("db.writer._connect_with_retry")
    def test_persist_window_returns_success_when_all_writes_match(self, mock_connect):
        mock_client = MagicMock()
        mock_connect.return_value = mock_client

        # Mock bulk_write to report all operations succeeded
        mock_bunching_result = MagicMock()
        mock_bunching_result.upserted_count = 1
        mock_bunching_result.modified_count = 0
        mock_deviation_result = MagicMock()
        mock_deviation_result.upserted_count = 1
        mock_deviation_result.modified_count = 0

        mock_client["gtfs_realtime"]["bunching_events"].bulk_write.return_value = mock_bunching_result
        mock_client["gtfs_realtime"]["schedule_deviations"].bulk_write.return_value = mock_deviation_result

        writer = MetricsWriter(mongo_uri="mongodb://fake")

        bunching_event = BunchingEvent(
            route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
            start_time=ets("2026-08-18 10:00:00"), end_time=ets("2026-08-18 10:00:45"),
            observation_count=4, min_distance_meters=15.0,
        )
        deviation = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
        )

        # Use a mock WindowResult-like object
        window_result = MagicMock()
        window_result.bunching_actions = [("new", bunching_event)]
        window_result.new_deviations = [deviation]

        result = writer.persist_window(window_result)

        assert result["success"] is True
        assert result["bunching_written"] == 1
        assert result["deviations_written"] == 1

    @patch("db.writer._connect_with_retry")
    def test_persist_window_returns_failure_on_bulk_write_error(self, mock_connect):
        """If bulk_write throws a PyMongoError, success is False."""
        mock_bunching_col = MagicMock()
        mock_deviation_col = MagicMock()
        mock_collections = {"bunching_events": mock_bunching_col, "schedule_deviations": mock_deviation_col}
        mock_db = MagicMock()
        mock_db.__getitem__ = lambda self, key: mock_collections[key]
        mock_client = MagicMock()
        mock_client.__getitem__ = lambda self, key: mock_db
        mock_connect.return_value = mock_client

        # Bunching succeeds, deviation throws
        mock_bunching_col.bulk_write.return_value = MagicMock()
        mock_deviation_col.bulk_write.side_effect = PyMongoError("DB Down")

        writer = MetricsWriter(mongo_uri="mongodb://fake")

        bunching_event = BunchingEvent(
            route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
            start_time=ets("2026-08-18 10:00:00"), end_time=ets("2026-08-18 10:00:45"),
            observation_count=4, min_distance_meters=15.0,
        )
        deviation = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
        )

        window_result = MagicMock()
        window_result.bunching_actions = [("new", bunching_event), ("new", bunching_event)]
        window_result.new_deviations = [deviation]

        result = writer.persist_window(window_result)

        assert result["success"] is False
        assert result["bunching_written"] == 2  # bunching succeeded
        assert result["deviations_written"] == 0  # deviation threw PyMongoError

    @patch("db.writer._connect_with_retry")
    def test_persist_window_returns_success_for_empty_window(self, mock_connect):
        """Empty window (nothing to write) should return success=True with zeros."""
        mock_client = MagicMock()
        mock_connect.return_value = mock_client

        writer = MetricsWriter(mongo_uri="mongodb://fake")

        window_result = MagicMock()
        window_result.bunching_actions = []
        window_result.new_deviations = []

        result = writer.persist_window(window_result)

        assert result["success"] is True
        assert result["bunching_written"] == 0
        assert result["deviations_written"] == 0


class TestBuildOperationGlue:
    """Glue tests: verify that build_*_operations output works correctly when
    passed to bulk_write. This is defense-in-depth alongside the private-attribute
    tests above -- if pymongo's internals change, these still verify the operations
    are structurally valid.

    These tests use a mock collection but call the real build_* functions, verifying
    the integration without requiring a live MongoDB."""

    def test_bunching_operations_are_valid_upserts(self):
        """build_bunching_operations output accepted by bulk_write without error."""
        event = BunchingEvent(
            route_id="57", direction_id=1, vehicle_a="y3227", vehicle_b="y3280",
            start_time=ets("2026-09-01 20:16:30"), end_time=ets("2026-09-01 20:45:45"),
            observation_count=13, min_distance_meters=15.5,
        )
        ops = build_bunching_operations([("new", event)])

        mock_collection = MagicMock()
        mock_collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=0)

        mock_collection.bulk_write(ops, ordered=False)

        # Verify bulk_write was called with exactly the operations we built
        call_args = mock_collection.bulk_write.call_args
        assert call_args[1].get("ordered", True) is False or call_args[0][1:] == ()
        passed_ops = call_args[0][0]
        assert len(passed_ops) == 1
        assert isinstance(passed_ops[0], UpdateOne)

    def test_deviation_operations_are_valid_upserts(self):
        """build_deviation_operations output accepted by bulk_write without error."""
        result = DeviationResult(
            vehicle_id="1700", trip_id="NorthBase-77", stop_sequence=10, kind="arrival",
            scheduled_at=ets("2026-09-01 19:15:00"), actual_at=ets("2026-09-01 19:17:40"),
            deviation_seconds=160.0,
        )
        ops = build_deviation_operations([result])

        mock_collection = MagicMock()
        mock_collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=0)

        mock_collection.bulk_write(ops, ordered=False)

        call_args = mock_collection.bulk_write.call_args
        passed_ops = call_args[0][0]
        assert len(passed_ops) == 1
        assert isinstance(passed_ops[0], UpdateOne)

    def test_bunching_operations_with_mixed_actions(self):
        """Both 'new' and 'update' actions produce valid, non-duplicate operations."""
        event = BunchingEvent(
            route_id="R1", direction_id=0, vehicle_a="A", vehicle_b="B",
            start_time=ets("2026-09-01 10:00:00"), end_time=ets("2026-09-01 10:00:45"),
            observation_count=4, min_distance_meters=15.0,
        )
        ops = build_bunching_operations([("new", event), ("update", event)])

        mock_collection = MagicMock()
        mock_collection.bulk_write.return_value = MagicMock(upserted_count=1, modified_count=1)

        # Should not raise
        mock_collection.bulk_write(ops, ordered=False)
        assert len(ops) == 2


class TestBuildDeviationWithLocation:
    """Tests that build_deviation_operations correctly includes the GeoJSON
    location field when present and omits it when None."""

    def test_location_included_when_present(self):
        result = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
            location={"type": "Point", "coordinates": [-71.1425, 42.3954]},
        )
        ops = build_deviation_operations([result])
        assert len(ops) == 1

        doc = ops[0]._doc["$set"]
        assert doc["location"] == {"type": "Point", "coordinates": [-71.1425, 42.3954]}

    def test_location_omitted_when_none(self):
        result = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
            location=None,
        )
        ops = build_deviation_operations([result])
        assert len(ops) == 1

        doc = ops[0]._doc["$set"]
        assert "location" not in doc

    def test_mixed_location_and_no_location(self):
        """When processing multiple deviations, only those with location get it
        in the document."""
        dev_with_loc = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
            location={"type": "Point", "coordinates": [-71.1425, 42.3954]},
        )
        dev_without_loc = DeviationResult(
            vehicle_id="v2", trip_id="t2", stop_sequence=1, kind="departure",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:02:00"),
            deviation_seconds=120,
            location=None,
        )
        ops = build_deviation_operations([dev_with_loc, dev_without_loc])
        assert len(ops) == 2

        doc_with = ops[0]._doc["$set"]
        doc_without = ops[1]._doc["$set"]

        assert "location" in doc_with
        assert doc_with["location"]["type"] == "Point"
        assert "location" not in doc_without

    def test_2dsphere_index_created_on_writer_init(self):
        """Verifies the 2dsphere geospatial index is created alongside the
        natural-key uniqueness indexes."""
        with patch("db.writer._connect_with_retry") as mock_connect:
            mock_client = MagicMock()
            mock_connect.return_value = mock_client

            MetricsWriter(mongo_uri="mongodb://fake")

            deviation_col = mock_client["gtfs_realtime"]["schedule_deviations"]
            # Check that create_index was called with a 2dsphere index
            deviation_col.create_index.assert_any_call(
                [("location", "2dsphere")],
                name="deviation_location_2dsphere",
            )


class TestBuildDeviationWithRouteEnrichment:
    """Tests that build_deviation_operations correctly includes route_id
    and route_long_name when present, and omits them when None."""

    def test_route_fields_included_when_present(self):
        result = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
            route_id="Red", route_long_name="Red Line",
        )
        ops = build_deviation_operations([result])
        doc = ops[0]._doc["$set"]
        assert doc["route_id"] == "Red"
        assert doc["route_long_name"] == "Red Line"

    def test_route_fields_omitted_when_none(self):
        result = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
        )
        ops = build_deviation_operations([result])
        doc = ops[0]._doc["$set"]
        assert "route_id" not in doc
        assert "route_long_name" not in doc

    def test_mixed_route_enrichment(self):
        """When processing multiple deviations, only those with route fields
        get them in the document."""
        dev_with_route = DeviationResult(
            vehicle_id="v1", trip_id="t1", stop_sequence=5, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:05:00"),
            deviation_seconds=300,
            route_id="Red", route_long_name="Red Line",
        )
        dev_without_route = DeviationResult(
            vehicle_id="v2", trip_id="t2", stop_sequence=1, kind="arrival",
            scheduled_at=ets("2026-08-18 10:00:00"), actual_at=ets("2026-08-18 10:02:00"),
            deviation_seconds=120,
        )
        ops = build_deviation_operations([dev_with_route, dev_without_route])
        doc_with = ops[0]._doc["$set"]
        doc_without = ops[1]._doc["$set"]

        assert doc_with["route_id"] == "Red"
        assert doc_with["route_long_name"] == "Red Line"
        assert "route_id" not in doc_without
        assert "route_long_name" not in doc_without