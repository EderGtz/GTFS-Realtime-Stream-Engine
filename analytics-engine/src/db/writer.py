"""
Persists computed Phase 3 metrics (bunching events, schedule deviations) to MongoDB.

Collection naming: `bunching_events` and `schedule_deviations`, not the original
README's `vehicle_telemetry`/`route_analytics` names, since those were named before
Phase 2 moved raw telemetry storage out of scope entirely (ingestion publishes to
Kafka now, not Mongo), and before the concrete BunchingEvent/DeviationResult shapes
existed. Naming collections after what they actually hold.

Write strategy: upsert-in-place, not an append-only audit log. This decistion was taken
considering the main objetive: to built a /live endpoint, not a /history one. For example,
if two vehicles have a bunching event at 10:00 and are still bunched at 10:05, there won't
be 5 records on the database, but only one that have been updated.

- Bunching events: natural key (route_id, direction_id, vehicle_a, vehicle_b,
  start_time). We explicitly include `start_time` in the database key—unlike the 
  in-memory tracker—so that if the same two vehicles bunch, separate, and 
  coincidentally bunch again hours later, the new incident creates a separate 
  document rather than silently overwriting the earlier one. `start_time` is 
  stable across "update" actions specifically because _BunchingEventTracker 
  (consumer.py) preserves first_seen_start_time rather than letting it drift 
  per window. This fix is the prerequisite that makes this a safe natural key 
  to upsert on at all. An "update" action overwrites the existing document's 
  end_time/observation_count/min_distance_meters in place, rather than creating 
  a new document per update. Chosen for MVP simplicity, matching the goal of 
  serving CURRENT bunching status (README Phase 4: GET /v1/delays/live). A
  full audit history of every intermediate update is real future work, not
  required for that goal.

- Schedule deviations: natural key (vehicle_id, trip_id, stop_sequence, kind).
  First-arrival/last-departure collapsing is idempotent by construction, so this
  isn't an "update" case the way bunching is; the upsert here is a second,
  PERSISTENT layer of duplicate protection, since _DeviationResultTracker's dedup
  is in-memory only and resets on every consumer restart (same defense-in-depth
  pattern as the ingestion side: Kafka's idempotent producer + Mongo's own unique
  index in Phases 1/2, not relying on a single layer).

Design gap resolved: the README's Phase 3 plan called for a 2dsphere
geospatial index on computed metrics. Deviation documents are now enriched
with a GeoJSON location field sourced from GTFS-static stop coordinates
(via stops_lookup, plumbed through consumer.py's _enrich_with_location),
and a 2dsphere index is created on schedule_deviations.location. Bunching
documents are NOT enriched -- a vehicle pair has no single natural location,
and no planned endpoint requires it. This can be revisited if bottleneck
clustering (Future Work) needs it.
"""
from __future__ import annotations

import time
from typing import TYPE_CHECKING, TypedDict

from pymongo import ASCENDING, MongoClient, UpdateOne
from pymongo.collection import Collection
from pymongo.errors import PyMongoError

from metrics.bunching import BunchingEvent
from metrics.schedule_deviation import DeviationResult
from utils.logger import get_logger

if TYPE_CHECKING:
    from consumer import WindowResult

logger = get_logger("analytics-engine.writer")

BUNCHING_COLLECTION = "bunching_events"
DEVIATION_COLLECTION = "schedule_deviations"


def _connect_with_retry(
        mongo_uri: str, 
        attempts: int = 5, 
        delay_seconds: float = 3.0
    ) -> MongoClient:
    """Same retry shape as producer.ts's connectWithRetry / setupKafka on the TS
    side: fail loud after exhausting attempts, don't retry forever silently."""

    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):

        try:
            client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
            client.admin.command("ping")  # forces an actual connection
            return client

        except PyMongoError as err:
            last_error = err

            if attempt == attempts:
                break

            logger.warning("Mongo connect failed (attempt %d/%d), retrying...", attempt, attempts)
            time.sleep(delay_seconds)

    raise ConnectionError(f"Could not connect to MongoDB after {attempts} attempts") from last_error


def build_bunching_operations(
        actions: list[tuple[str, BunchingEvent]]
    ) -> list[UpdateOne]:
    """
    Pure function: turns (action, event) pairs into upsert operations, with no
    I/O. Kept separate from MetricsWriter.write_bunching_actions() specifically so
    the key/document shape can be unit-tested without a live MongoDB connection.
    same separation-of-concerns pattern as poller.ts's fetchFeedBuffer/decodeFeed
    split, or bunching.py's pure functions vs. consumer.py's I/O wrapper.
    Bunching detection evaluates whether two vehicles on the same route are too close together. 

    Both "new" and "update" actions produce the identical upsert, and the
    distinction only matters for logging, not for how the write itself behaves,
    since upsert already means "insert if absent, else replace."
    """
    operations = []
    for action, event in actions:
        key = {
            "route_id": event.route_id,
            "direction_id": event.direction_id,
            "vehicle_a": event.vehicle_a,
            "vehicle_b": event.vehicle_b,
            "start_time": event.start_time.to_pydatetime(),
        }

        document = {
            **key,
            "end_time": event.end_time.to_pydatetime(),
            "observation_count": event.observation_count,
            "min_distance_meters": event.min_distance_meters,
            "last_action": action,
        }
        operations.append(UpdateOne(key, {"$set": document}, upsert=True))

    return operations


def build_deviation_operations(results: list[DeviationResult]) -> list[UpdateOne]:
    """
    Pure function, same reasoning as build_bunching_operations() above.

    Schedule deviation determines whether a vehicle is running late or 
    early, and by how much.  This metric is computed by comparing a 
    vehicle's actual position and timestamp against its scheduled 
    stop time.
    """
    operations = []

    for result in results:
        key = {
            "vehicle_id": result.vehicle_id,
            "trip_id": result.trip_id,
            "stop_sequence": result.stop_sequence,
            "kind": result.kind,
        }

        document = {
            **key,
            "scheduled_at": result.scheduled_at.to_pydatetime(),
            "actual_at": result.actual_at.to_pydatetime(),
            "deviation_seconds": result.deviation_seconds,
        }

        # Location is optional -- only present when stop coordinates
        # were available from the GTFS-static stops_lookup. Stored as
        # GeoJSON so the 2dsphere index can serve future geospatial
        # queries (e.g. "show all delays near this stop").
        if result.location is not None:
            document["location"] = result.location

        operations.append(UpdateOne(key, {"$set": document}, upsert=True))

    return operations

class PersistWindowResult(TypedDict):
    bunching_written: int
    deviations_written: int
    success: bool

class MetricsWriter:
    """
    Persists WindowResult output (bunching actions + new deviation results) to
    MongoDB. One instance per running consumer; safe to call repeatedly, once per
    window, from AnalyticsConsumer's on_window_result callback:

        writer = MetricsWriter(mongo_uri)

        def on_window_result(result: WindowResult) -> None:
            persist_window_result = writer.persist_window(result)

        consumer = AnalyticsConsumer(..., on_window_result=on_window_result)
    """

    def __init__(self, mongo_uri: str, db_name: str = "gtfs_realtime"):
        self.client = _connect_with_retry(mongo_uri)
        self.db = self.client[db_name]

        self.bunching_collection: Collection = self.db[BUNCHING_COLLECTION]
        self.deviation_collection: Collection = self.db[DEVIATION_COLLECTION]

        self._ensure_indexes()

    def _ensure_indexes(self) -> None:
        # Natural-key uniqueness enforced at the database level, not relied on
        # via the in-memory trackers alone, which reset on every consumer restart.
        self.bunching_collection.create_index(
            [("route_id", ASCENDING), ("direction_id", ASCENDING),
             ("vehicle_a", ASCENDING), ("vehicle_b", ASCENDING), ("start_time", ASCENDING)],
            unique=True,
            name="bunching_natural_key",
        )
        self.deviation_collection.create_index(
            [("vehicle_id", ASCENDING), ("trip_id", ASCENDING),
             ("stop_sequence", ASCENDING), ("kind", ASCENDING)],
            unique=True,
            name="deviation_natural_key",
        )
        # Geospatial index on deviation documents that carry a location
        # (enriched from GTFS-static stop coordinates in consumer.py).
        # Enables future queries like "show all delays near this stop"
        # or "find the closest bunching event to this lat/lon".
        self.deviation_collection.create_index(
            [("location", "2dsphere")],
            name="deviation_location_2dsphere",
        )

    def write_bunching_actions(self, actions: list[tuple[str, BunchingEvent]]) -> int:

        if not actions:
            return 0
        
        operations = build_bunching_operations(actions)

        try:
            result = self.bunching_collection.bulk_write(operations, ordered=False)
            return result.upserted_count + result.modified_count

        except PyMongoError:
            logger.exception("Failed to write %d bunching action(s) to MongoDB.", len(actions))
            return 0

    def write_deviation_results(self, results: list[DeviationResult]) -> int:
        if not results:
            return 0
        operations = build_deviation_operations(results)
        try:
            result = self.deviation_collection.bulk_write(operations, ordered=False)
            return result.upserted_count + result.modified_count
        except PyMongoError:
            logger.exception("Failed to write %d deviation result(s) to MongoDB.", len(results))
            return 0

    def persist_window(self, result: WindowResult) -> PersistWindowResult:
        bunching_total = len(result.bunching_actions)
        deviation_total = len(result.new_deviations)

        bunching_written = self.write_bunching_actions(result.bunching_actions)
        deviation_written = self.write_deviation_results(result.new_deviations)
        
        return {
            "bunching_written": bunching_written,
            "deviations_written": deviation_written,
            "success": (bunching_written == bunching_total) and (deviation_written == deviation_total)
        }

    def close(self) -> None:
        self.client.close()