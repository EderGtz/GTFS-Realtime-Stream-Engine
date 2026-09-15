# System Guarantees

This document describes the behavioral guarantees currently provided by the GTFS Realtime Stream Engine. These guarantees are based on the exact implementation and infrastructure design of the Phase 3 Analytics Engine. They are explicitly stated to clarify what the system *does* and *does not* promise.

## 1. Message Delivery

**Guarantee: At-least-once processing**

The system favors reliable processing over exact processing. Kafka's `enable.auto.commit` is set to `False`. The analytics consumer reads a window of messages, processes them, attempts to persist the computed metrics, and **only commits the Kafka offset if the database write is 100% successful**.

If the consumer crashes during processing, or if MongoDB is temporarily unavailable, the offset is not committed. Upon restart, Kafka will redeliver the uncommitted messages. Therefore, the same logical input may be processed multiple times. Exactly-once end-to-end processing is not guaranteed.

## 2. Metric Persistence

**Guarantee: Idempotent persistence with respect to defined natural keys**

To safely support the at-least-once delivery model without duplicating data, all metric persistence is idempotent. Computed Phase 3 metrics are persisted using MongoDB `Upsert` operations backed by database-level unique indexes.

*   **Bunching Events Key:** `route_id`, `direction_id`, `vehicle_a`, `vehicle_b`, `start_time`
*   **Schedule Deviations Key:** `vehicle_id`, `trip_id`, `stop_sequence`, `kind`

If Kafka redelivers a previously processed window, MongoDB will attempt the upsert again, recognize the existing natural key, and overwrite the document in place with identical data. Duplicate metric documents will not be created.

## 3. Database Atomicity

**Guarantee: No cross-document transactions**

The system does not utilize MongoDB distributed transactions (which require a Replica Set topology). The `persist_window` operation executes batch writes for bunching events and schedule deviations independently.

If a batch partially succeeds and then encounters a database error, the operation halts and the Kafka offset is not committed. On the next retry cycle, the idempotency guarantees (see Section 2) ensure the partially written data safely converges to the correct state without duplication.

## 4. Bunching Event Identity and Updates

**Guarantee: Distinct incidents remain distinguishable, active incidents converge**

The natural key for a bunching event explicitly includes the `start_time`. This ensures that if the same two vehicles bunch at 10:00 AM, separate, and bunch again at 2:00 PM, they are persisted as two distinct incidents rather than silently overwriting the historical record.

For an ongoing incident, the system updates the existing document in place (updating `end_time`, `observation_count`, and preserving the absolute minimum `min_distance_meters` observed). It does not maintain an append-only audit log of intermediate states, aligning with the MVP goal of serving current live delays.

## 5. Ordering

**Guarantee: Partition-scoped ordering (Pending Ingestion Phase)**

The analytics engine does not enforce global ordering across the entire pipeline. Kafka ordering is partition-scoped. The system's ability to process vehicle observations in correct chronological sequence relies on the upstream Ingestion Service (Phase 1 & 2) assigning the `vehicle_id` as the Kafka message key.

## 6. Data Loss

**Guarantee: No unconditional zero-data-loss guarantee**

While the at-least-once architecture and idempotent persistence strongly protect against data loss during downstream transient failures, the system is an MVP and does not provide an absolute zero-data-loss guarantee. Data may still be lost if Kafka evicts a message before processing (retention limits), or if the upstream Ingestion Service fails to publish to the broker.
