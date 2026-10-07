"""
Integration tests for the analytics engine.

These tests require Docker and spin up real Kafka and MongoDB containers via
testcontainers. They verify the infrastructure integration that unit tests
(mocked Kafka/Mongo) cannot cover:

1. Kafka produce/consume roundtrip with real broker
2. MongoDB persistence: indexes, upserts, document shape, 2dsphere
3. End-to-end: Kafka produce -> consume -> process -> MongoDB persist,
   with GTFS-static data from a real feed fixture (tests/fixtures/gtfs/)

Run with: uv run pytest tests/test_integration.py -v
Requires: Docker daemon running on the host.
"""

import json
import time
from pathlib import Path
from typing import cast

import pandas as pd
import pytest
from confluent_kafka import Consumer, Producer
from testcontainers.community.kafka import KafkaContainer
from testcontainers.community.mongodb import MongoDbContainer

from consumer import AnalyticsConsumer, WindowResult
from db.writer import MetricsWriter
from gtfs_static.loader import GtfsStaticData
from metrics.bunching import BunchingEvent
from metrics.schedule_deviation import DeviationResult, to_eastern

# Only run when Docker is available; skip in environments without it.
pytestmark = pytest.mark.skipif(
    not Path("/var/run/docker.sock").exists(),
    reason="Docker daemon not available",
)

EASTERN = "America/New_York"


def ets(time_str: str) -> pd.Timestamp:
    return pd.Timestamp(time_str, tz=EASTERN)


# ---------------------------------------------------------------------------
# Module-scoped containers: expensive to start, shared across all tests.
# This means tests within a class are NOT isolated from each other.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def kafka():
    container = KafkaContainer("confluentinc/cp-kafka:7.6.0")
    container.start()
    yield container
    container.stop()


@pytest.fixture(scope="module")
def mongodb():
    container = MongoDbContainer("mongo:7.0")
    container.start()
    yield container
    container.stop()


@pytest.fixture(scope="module")
def mongo_uri(mongodb):
    return mongodb.get_connection_url()

@pytest.fixture(scope="module")
def bootstrap_servers(kafka):
    return kafka.get_bootstrap_server()

# ---------------------------------------------------------------------------
# 1. Kafka produce/consume roundtrip
# ---------------------------------------------------------------------------

class TestKafkaRoundtrip:
    """Verifies that a message produced to Kafka can be consumed back with
    the correct payload. This is the same contract the TypeScript side's
    verify-kafka-roundtrip.ts validates."""

    def test_produce_consume_roundtrip(self, bootstrap_servers):
        topic = "integration-test-roundtrip"

        # Produce
        producer = Producer({"bootstrap.servers": bootstrap_servers})
        payload = {
            "vehicle_id": "int-v1",
            "trip_id": "int-t1",
            "route_id": "R1",
            "lat": 42.3954,
            "lon": -71.1425,
            "timestamp_eastern": "2026-09-14 10:00:00",
        }
        producer.produce(topic, json.dumps(payload).encode("utf-8"))
        producer.flush(timeout=10)

        # Consume
        consumer = Consumer({
            "bootstrap.servers": bootstrap_servers,
            "group.id": "integration-test-group",
            "auto.offset.reset": "earliest",
        })
        consumer.subscribe([topic])

        msg = consumer.poll(timeout=15.0)
        consumer.close()

        assert msg is not None, "No message received within timeout"
        assert msg.error() is None, f"Kafka error: {msg.error()}"

        received = json.loads(msg.value().decode("utf-8"))
        assert received == payload

    def test_produce_consume_binary_payload(self, bootstrap_servers):
        """Verifies that binary-encoded JSON (matching the real ingestion
        service's behavior) roundtrips correctly."""
        topic = "integration-test-binary"
        producer = Producer({"bootstrap.servers": bootstrap_servers})
        payload = {"vehicle_id": "bin-v1", "test": True}
        raw = json.dumps(payload).encode("utf-8")

        producer.produce(topic, raw)
        producer.flush(timeout=10)

        consumer = Consumer({
            "bootstrap.servers": bootstrap_servers,
            "group.id": "integration-test-binary-group",
            "auto.offset.reset": "earliest",
        })
        consumer.subscribe([topic])

        msg = consumer.poll(timeout=15.0)
        consumer.close()

        assert msg is not None
        assert msg.error() is None
        # The value should be bytes, decodable as UTF-8 JSON
        received = json.loads(msg.value().decode("utf-8"))
        assert received["vehicle_id"] == "bin-v1"

# ---------------------------------------------------------------------------
# 2. MongoDB persistence: indexes, upserts, document shape, 2dsphere
# ---------------------------------------------------------------------------

class TestMongoDBPersistence:
    """Verifies MetricsWriter against a real MongoDB instance: index creation,
    upsert behavior, document shape, and the 2dsphere geospatial index."""

    def test_indexes_created_on_init(self, mongo_uri):
        """All three indexes (bunching natural key, deviation natural key,
        deviation 2dsphere) must exist after MetricsWriter initialization."""
        db_name = "test_indexes"
        writer = MetricsWriter(mongo_uri=mongo_uri, db_name=db_name)

        bunching_indexes = {
            idx["name"]
            for idx in writer.bunching_collection.list_indexes()
        }
        deviation_indexes = {
            idx["name"]
            for idx in writer.deviation_collection.list_indexes()
        }

        assert "bunching_natural_key" in bunching_indexes
        assert "deviation_natural_key" in deviation_indexes
        assert "deviation_location_2dsphere" in deviation_indexes

        writer.close()

    def test_bunching_upsert_creates_and_updates(self, mongo_uri):
        """First write inserts, second write with same key updates in place."""
        db_name = "test_bunching_upsert"
        writer = MetricsWriter(mongo_uri=mongo_uri, db_name=db_name)

        event = BunchingEvent(
            route_id="UPSERT-R1", direction_id=0,
            vehicle_a="UPSERT-A", vehicle_b="UPSERT-B",
            start_time=ets("2026-09-14 10:00:00"),
            end_time=ets("2026-09-14 10:00:45"),
            observation_count=4, min_distance_meters=15.0,
        )

        # First write: insert
        count1 = writer.write_bunching_actions([("new", event)])
        assert count1 == 1

        doc = writer.bunching_collection.find_one({
            "route_id": "UPSERT-R1",
            "vehicle_a": "UPSERT-A",
            "vehicle_b": "UPSERT-B",
        })
        assert doc is not None
        assert doc["observation_count"] == 4
        assert doc["last_action"] == "new"

        # Second write: update (same key, extended end_time)
        from dataclasses import replace
        updated_event = replace(
            event,
            end_time=ets("2026-09-14 10:01:30"),
            observation_count=6,
            min_distance_meters=12.0,
        )
        count2 = writer.write_bunching_actions([("update", updated_event)])
        assert count2 == 1

        doc2 = writer.bunching_collection.find_one({
            "route_id": "UPSERT-R1",
            "vehicle_a": "UPSERT-A",
            "vehicle_b": "UPSERT-B",
        })
        assert doc2["observation_count"] == 6
        assert doc2["last_action"] == "update"
        assert doc2["min_distance_meters"] == 12.0

        # Only ONE document should exist (upsert, not insert)
        total = writer.bunching_collection.count_documents({
            "route_id": "UPSERT-R1",
        })
        assert total == 1

        writer.close()

    def test_deviation_with_location_persists_geojson(self, mongo_uri):
        """Deviation with a GeoJSON location should be queryable via the
        2dsphere index."""
        db_name = "test_deviation_geojson"
        writer = MetricsWriter(mongo_uri=mongo_uri, db_name=db_name)

        dev = DeviationResult(
            vehicle_id="GEO-V1", trip_id="GEO-T1", stop_sequence=5,
            kind="arrival",
            scheduled_at=ets("2026-09-14 10:00:00"),
            actual_at=ets("2026-09-14 10:05:00"),
            deviation_seconds=300,
            location={
                "type": "Point",
                "coordinates": [-71.1425, 42.3954],
            },
        )
        count = writer.write_deviation_results([dev])
        assert count == 1

        doc = writer.deviation_collection.find_one({
            "vehicle_id": "GEO-V1",
        })
        assert doc is not None
        assert doc["location"]["type"] == "Point"
        assert doc["location"]["coordinates"] == [-71.1425, 42.3954]

        # Geospatial query: find documents near this point
        nearby = writer.deviation_collection.find({
            "location": {
                "$near": {
                    "$geometry": {
                        "type": "Point",
                        "coordinates": [-71.1425, 42.3954],
                    },
                    "$maxDistance": 1000,  # 1km
                },
            },
        })
        results = list(nearby)
        assert len(results) >= 1
        assert results[0]["vehicle_id"] == "GEO-V1"

        writer.close()

    def test_deviation_without_location_still_persists(self, mongo_uri):
        """Deviation with location=None should persist without a location
        field in the document."""
        db_name = "test_deviation_no_loc"
        writer = MetricsWriter(mongo_uri=mongo_uri, db_name=db_name)

        dev = DeviationResult(
            vehicle_id="NOLOC-V1", trip_id="NOLOC-T1", stop_sequence=1,
            kind="departure",
            scheduled_at=ets("2026-09-14 11:00:00"),
            actual_at=ets("2026-09-14 11:02:00"),
            deviation_seconds=120,
            location=None,
        )
        count = writer.write_deviation_results([dev])
        assert count == 1

        doc = writer.deviation_collection.find_one({"vehicle_id": "NOLOC-V1"})
        assert doc is not None
        assert "location" not in doc

        writer.close()

    def test_persist_window_returns_correct_counts(self, mongo_uri):
        """persist_window should return accurate written counts against
        a real MongoDB."""
        db_name = "test_persist_counts"
        writer = MetricsWriter(mongo_uri=mongo_uri, db_name=db_name)

        event = BunchingEvent(
            route_id="PW-R1", direction_id=0,
            vehicle_a="PW-A", vehicle_b="PW-B",
            start_time=ets("2026-09-14 12:00:00"),
            end_time=ets("2026-09-14 12:00:45"),
            observation_count=4, min_distance_meters=15.0,
        )
        dev = DeviationResult(
            vehicle_id="PW-V1", trip_id="PW-T1", stop_sequence=3,
            kind="arrival",
            scheduled_at=ets("2026-09-14 12:00:00"),
            actual_at=ets("2026-09-14 12:04:00"),
            deviation_seconds=240,
            location={"type": "Point", "coordinates": [-71.0, 42.0]},
        )

        window_result = WindowResult(
            bunching_actions=[("new", event)],
            new_deviations=[dev],
            total_records=2,
        )

        result = writer.persist_window(window_result)

        assert result["success"] is True
        assert result["bunching_written"] == 1
        assert result["deviations_written"] == 1

        writer.close()

# ---------------------------------------------------------------------------
# 3. End-to-end: Kafka produce -> consume -> process -> MongoDB persist
# ---------------------------------------------------------------------------

def _pick_scheduled_stop(static: GtfsStaticData):
    """Deterministically choose the (trip, stop_sequence) the e2e pings are
    built around: a trip with a real scheduled arrival at a stop with real
    coordinates. Sorted iteration keeps the choice stable across runs.
    Past-midnight arrivals are skipped here because their anchoring behavior is
    covered by the fixture quirk tests, not this pipeline test."""
    for (trip_id, stop_sequence), scheduled in sorted(static.stop_times_lookup.items()):
        if trip_id not in static.direction_lookup or trip_id not in static.trip_route_lookup:
            continue
        if scheduled.arrival_time is None or scheduled.arrival_time >= 24 * 3600:
            continue
        stop_info = (
            static.stops_lookup.get(scheduled.stop_id)
            if scheduled.stop_id
            else None
        )
        if stop_info is None or stop_info.stop_lat is None or stop_info.stop_lon is None:
            continue
        route_id = static.trip_route_lookup[trip_id]
        return trip_id, stop_sequence, scheduled, stop_info, route_id
    raise AssertionError("fixture feed has no scheduled stop with coordinates")


class TestEndToEndPipeline:
    """Full pipeline integration: produce vehicle pings derived from a real GTFS
    feed fixture, consume them through a real AnalyticsConsumer, and verify the
    results landed in MongoDB enriched with real schedule data.

    Uses a real Kafka broker, real MongoDB, and the curated MBTA fixture from
    tests/fixtures/gtfs/ as GTFS-static data.
    The pings arrive exactly 60 seconds after a real scheduled stop time at a
    stop with real coordinates, so the assertions can check exact deviation
    values and the enrichment (route name, GeoJSON location) the consumer
    attaches from the feed."""

    def test_kafka_to_mongodb_pipeline(self, bootstrap_servers, mongo_uri, gtfs_fixture):
        topic = "integration-e2e-pipeline"
        db_name = "test_e2e"

        # 1. Load the real feed fixture and pick a deterministic scheduled stop
        #    to build the pings around.
        feed_dir = gtfs_fixture("mbta-2019-07-25")
        static = GtfsStaticData(feed_dir)
        static.load()

        trip_id, stop_sequence, scheduled, stop_info, route_id = _pick_scheduled_stop(static)
        route_name = static.routes_lookup.get(route_id)
        arrival_seconds = scheduled.arrival_time
        assert arrival_seconds is not None

        # Two vehicles report the same trip at the same stop: two vehicles on
        # top of each other is exactly what bunching detection looks for, and
        # both generate an arrival deviation at the same scheduled stop.
        midnight = to_eastern(pd.Timestamp.now(tz="UTC")).normalize()
        scheduled_dt = cast(
            pd.Timestamp, midnight + pd.Timedelta(seconds=arrival_seconds)
        )
        actual_dt = cast(
            pd.Timestamp, scheduled_dt + pd.Timedelta(seconds=60)
        )  # exactly 1 min late

        def make_ping(vehicle_id: str, at: pd.Timestamp) -> dict:
            # Shape matches what ingestion-service/src/ingestion/validator.ts
            # publishes (IVehicleTelemetry + producer's agency_id/ingested_at).
            return {
                "agency_id": "mbta",
                "vehicle_id": vehicle_id,
                "trip_id": trip_id,
                "route_id": route_id,
                "direction_id": static.direction_lookup[trip_id],
                "location": {
                    "type": "Point",
                    "coordinates": [stop_info.stop_lon, stop_info.stop_lat],
                },
                "timestamp": at.tz_convert("UTC").isoformat(),
                "bearing": None,
                "speed": None,
                "current_stop_sequence": stop_sequence,
                "stop_id": scheduled.stop_id,
                "current_status": "STOPPED_AT",
                "ingested_at": actual_dt.tz_convert("UTC").isoformat(),
            }

        # Two poll buckets 15s apart with both vehicles in each one: the
        # minimum persistence run bunching detection accepts (two consecutive
        # observations).
        ping_times: list[pd.Timestamp] = [
            actual_dt,
            cast(pd.Timestamp, actual_dt + pd.Timedelta(seconds=15)),
        ]
        pings = [make_ping(v, at) for at in ping_times for v in ("E2E-A", "E2E-B")]

        # 2. Produce to Kafka and consume back with a real Consumer
        producer = Producer({"bootstrap.servers": bootstrap_servers})
        for ping in pings:
            producer.produce(topic, json.dumps(ping).encode("utf-8"))
        producer.flush(timeout=10)

        kafka_consumer = Consumer({
            "bootstrap.servers": bootstrap_servers,
            "group.id": "integration-e2e-group",
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
        })
        kafka_consumer.subscribe([topic])
        consumed_pings = []
        deadline = time.time() + 15
        while time.time() < deadline and len(consumed_pings) < len(pings):
            msg = kafka_consumer.poll(timeout=2.0)
            value = msg.value() if msg is not None and msg.error() is None else None
            if value is not None:
                consumed_pings.append(json.loads(value.decode("utf-8")))

        assert len(consumed_pings) == len(pings), (
            f"Expected {len(pings)} pings, got {len(consumed_pings)}"
        )

        # 3. Process through the analytics pipeline against the real feed
        writer = MetricsWriter(mongo_uri=mongo_uri, db_name=db_name)

        def on_window_result(result: WindowResult):
            return writer.persist_window(result)

        consumer = AnalyticsConsumer(
            kafka_config={
                "bootstrap.servers": bootstrap_servers,
                "group.id": "integration-e2e-consumer",
                "auto.offset.reset": "earliest",
            },
            topic=topic,
            gtfs_dir=feed_dir,
            on_window_result=on_window_result,
        )

        for ping in consumed_pings:
            consumer.buffer.add(ping)

        pings_df = consumer.buffer.flush()
        # buffer.flush() creates timestamp_eastern from the `timestamp` field
        # via to_eastern(), so no manual conversion is needed here.

        result = consumer._process_window(pings_df)

        # 4. Verify the persisted results
        assert result is not None
        assert result["success"] is True
        assert result["deviations_written"] == 2  # one arrival event per vehicle
        assert result["bunching_written"] == 1

        # Deviations: each vehicle was exactly 60s late at a real scheduled
        # stop, and the consumer enriched the result with the route name and
        # the stop's real coordinates from the fixture feed.
        docs = list(writer.deviation_collection.find({"trip_id": trip_id}))
        assert len(docs) == 2
        for doc in docs:
            assert doc["kind"] == "arrival"
            assert doc["stop_sequence"] == stop_sequence
            assert doc["deviation_seconds"] == pytest.approx(60)
            assert doc["route_id"] == route_id
            assert doc["route_long_name"] == route_name
            assert doc["location"] == {
                "type": "Point",
                "coordinates": [stop_info.stop_lon, stop_info.stop_lat],
            }

        # Bunching: the two vehicles sat at the same real stop for both poll
        # buckets.
        bunch = writer.bunching_collection.find_one({"route_id": route_id})
        assert bunch is not None
        assert bunch["vehicle_a"] == "E2E-A"
        assert bunch["vehicle_b"] == "E2E-B"
        assert bunch["direction_id"] == static.direction_lookup[trip_id]
        assert bunch["observation_count"] == 2
        assert bunch["min_distance_meters"] == pytest.approx(0.0)

        kafka_consumer.close()
        writer.close()
