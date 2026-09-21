# GTFS Realtime Stream Engine

An event-driven pipeline that ingests, processes, and analyzes real-time public transit telemetry.

## Why This Project Exists

Most "real-time transit dashboard" projects call a pre-digested status API (like the ones provided by Transport For London or Bay Area Rapid Transit) and render it on a map. This one doesn't. It ingests **raw binary GTFS-Realtime feeds** (the actual protobuf format transit agencies publish), decouples ingestion from processing with **Kafka**, and computes its own delay and bunching metrics instead of trusting someone else's summary.

The goal is to build a real, working end-to-end event-driven system using real public data instead of mocked data — and to have something that actually runs continuously and produces real numbers. The pipeline itself (ingestion → streaming → analytics → API) is the core product. A `curl`/terminal demo proves the pipeline works; a lightweight Leaflet map served from the same Express server proves the data is useful.

## Architecture Overview

```
                        [ MBTA GTFS-Realtime Feed ]
                                  │
                                  ▼
          ┌──────────────────────────────────────────────┐
          │     ingestion-service (TypeScript)           │
          │  - Polls MBTA feed on an interval            │
          │  - Decodes Protobuf → typed JSON             │
          │  - Validates & skips malformed entries       │
          │  - Publishes to Kafka                        │
          └───────────────────────┬──────────────────────┘
                                  │  (Kafka event stream)
                       ┌────────────────────────┐
                       │     Apache Kafka       │
                       │  raw.vehicle-positions │
                       └──────────┬─────────────┘
                                  │  (consumer group)
        ┌────────────────────────────────────────────────┐
        │     analytics-engine (Python + pandas)         │
        │  - Loads & periodically refreshes GTFS-static  │
        │  - Joins real-time pings against schedule      │
        │  - Computes delay & bunching metrics           │
        └───────────────────────┬────────────────────────┘
                                  │  (persisted metrics)
                       ┌────────────────────────┐
                       │       MongoDB          │
                       │  bunching_events       │
                       │  schedule_deviations   │
                       │  (2dsphere on location)│
                       └──────────┬─────────────┘
                                  │
        ┌────────────────────────────────────────────────┐
        │       public-api (TypeScript / Express)        │
        │  - Serves computed delays & analytics          │
        │  - GET /v1/status/live                         │
        └────────────────────────────────────────────────┘
                                  │
                          (curl / terminal demo —
                           no frontend in this MVP)
```

The GTFS-Realtime Stream Engine is a decoupled, event-driven pipeline designed to ingest, process, and serve public transit telemetry at scale. The architecture is divided into five distinct layers:

1. **Ingestion Layer (Node.js / TypeScript):** A lightweight, fault-tolerant service that polls the MBTA's raw binary Protobuf feed. It handles schema decoding, spatial validation, and data cleaning. Instead of writing directly to a database, it acts purely as a Kafka Producer.
2. **Streaming Layer (Apache Kafka - KRaft Mode):** It uses a single Kafka broker running in KRaft mode (acting as both broker and controller). It buffers the incoming telemetry into a topic (`raw.vehicle-positions`) with 4 partitions, effectively decoupling the high-frequency ingestion from the heavy analytical processing.
3. **Analytics Engine (Python / Pandas):** A dedicated Kafka Consumer that reads telemetry in batches. It loads static GTFS schedules into memory, performs spatial and temporal joins, and calculates high-value metrics like schedule deviation and vehicle bunching.
4. **Storage Layer (MongoDB):** Acts as a sink for the processed analytics. Bunching events and schedule deviations are persisted via idempotent upserts backed by unique natural-key indexes. Schedule deviation documents are enriched with stop coordinates and indexed with a `2dsphere` geospatial index for future location-based queries.
5. **Serving API (Node.js / Express):** A thin REST interface that reads the processed metrics from MongoDB and serves them to end clients, completely isolated from the complexities of the ingestion and processing pipelines.

## Tech Stack

| Layer | Technology | Responsibility |
|---|---|---|
| Ingestion | TypeScript, Node.js, `protobufjs` or `gtfs-realtime-bindings` | Poll the MBTA GTFS-RT feed, decode binary Protobuf into typed objects, validate, publish to Kafka |
| Event Broker | Apache Kafka, Docker | Decouple ingestion cadence from analytics processing; buffer against feed hiccups |
| Analytics Engine | Python 3.12+, `confluent-kafka`, `pandas`, `numpy` | Join real-time pings against static schedule data, compute delay/bunching, explore the data before finalizing metrics |
| Data Store | MongoDB | Bunching events and schedule deviations persisted via idempotent upserts; `2dsphere` geospatial index on deviation locations |
| Serving API | TypeScript, Node.js, Express | REST endpoint exposing computed metrics |
| Runtime | Docker Compose, small VPS/cloud VM | Full stack running continuously to test the code working in production |

## MVP Scope — What v1 Will Actually Cover

The MVP is scoped deliberately small and built in order, with each phase a working, demoable checkpoint on its own:

- **One transit agency, one feed type**: MBTA's `VehiclePositions` GTFS-Realtime feed — not the full GTFS-RT spec, not multiple agencies.
- **Two computed metrics** — schedule deviation (is a vehicle late, and by how much) and bunching detection (are two vehicles on the same route too close together) — not the full list of possible analytics. Bunching thresholds get decided from real MBTA data (see Phase 3).
- **One serving endpoint** (`GET /v1/status/live`) before building out reliability history or bottleneck detection.
- **A lightweight map.** A static Leaflet page served from Express, consuming `/v1/status/live` on a polling interval. It shows deviation markers and bunching events on a map of Boston. The `curl` demo proves the pipeline works; the map proves the data is useful.
- **Runs continuously.** The MVP isn't "done" until it's been deployed somewhere that stays up 24/7 and has collected real data over multiple days (see Phase 6).

Everything else (trip-update feeds, historical reliability windows, bottleneck clustering, multiple agencies) is real future work, described at the end of this README, not part of the MVP.

## Build Phases

### Phase 1 — Ingestion Service (TypeScript)

**Goal: get real data flowing end-to-end as fast as possible, with real failure handling from day one.**

**Feed:** MBTA GTFS-Realtime `VehiclePositions` — https://cdn.mbta.com/realtime/VehiclePositions.pb

This phase polls the MBTA feed on a 15-second interval, decodes the raw Protobuf payload into a typed JSON object using `protobufjs`, and writes it straight into MongoDB. No Kafka yet.

Skipping Kafka here isn't cutting a corner; it's intentional sequencing. The whole point of this phase is to get a fast feedback loop: see what a real feed actually looks like before making any decisions about how that data should be partitioned, buffered, or processed downstream. 

**Implementation Details:**
- **Validation:** Enforces strict GeoJSON formatting and drops vehicles lacking mandatory coordinates or IDs to ensure clean data for downstream analytics.
- **Idempotency:** Implements a MongoDB Compound Unique Index (`vehicle_id` + `timestamp`) combined with unordered `bulkWrite()` operations. This ensures that feed hiccups (MBTA broadcasting the exact same payload twice) are silently deduplicated at the database level without crashing the ingestion loop.
- **Observability:** Replaced standard console logs with `pino` for structured, leveled JSON logging.
- **Failure-mode behavior:**
  - Malformed or partial feed entries are logged and skipped — one bad message never crashes the poller.
  - After 5 consecutive poll failures, the poller triggers a `fatal` alert log rather than failing silently or retrying forever unnoticed.

**Testing & CI:**
- Unit tests written in `vitest` cover the Protobuf decode step and validation logic against a captured sample payload (`fixtures/mbta_feed.pb`), independent of live network access.
- GitHub Actions workflow runs the test suite on every push.

**Acceptance criteria (pass/fail):**
- [X] Polls the MBTA feed on interval without crashing for a sustained unattended run (target: 1 hour+). 
- [X] Decodes raw Protobuf into typed JSON with zero unhandled decode exceptions across that run
- [X] Malformed/partial entries are logged and skipped, never fatal
- [X] Writes valid documents to MongoDB with correct `vehicle_id`, `trip_id`, `lat`/`lon`, `timestamp`
- [X] Unit tests passes against a captured fixture payload
- [X] CI workflow runs the test suite successfully on push

By the end of Phase 1, there should be a small but real collection of live vehicle position documents in MongoDB, pulled from MBTA, decoded from raw binary Protobuf — proof that the hardest part (talking to a real, undocumented-in-practice binary feed, with real failure handling) works.

#### Live Demo

![Terminal Ingestion Demo](docs/img/phase1_demo.gif)
*Live ingestion logs filtering duplicates and malformed data.*

![MongoDB Telemetry View](docs/img/phase1_mongo.png)
*VSCode MongoDB extension showing the 2dsphere indexed telemetry documents.*

### Phase 2 — Event Streaming Layer (Apache Kafka)

**Goal: introduce the decoupling layer, now that the data shape is understood.**

Once Phase 1 has produced real, inspected data, the ingestion service is refactored to publish to Kafka instead of writing directly to Mongo — `raw.vehicle-positions` as the first topic. Kafka sits between ingestion and everything downstream so that:

- Ingestion can keep polling at its own pace even if analytics processing is temporarily slow or down.
- A feed hiccup or MBTA outage doesn't take down anything else in the system.
- More consumers can be added later (an alerting service, a logging service, a second analytics variant) without ever touching the ingestion code again.

It is relevant to mention that this phase **does not keep track** of duplicated records as the phase 1 due the way Kafka works. The responsability has moved downstream, and the consumer functions will verify this cases.

**Testing:** test that verifies a message published to `raw.vehicle-positions` matches the expected schema — catches a schema drift before it silently breaks the analytics engine in Phase 3.

**Acceptance criteria:**
- [x] Ingestion service publishes decoded messages to `raw.vehicle-positions` instead of writing directly to Mongo
- [x] A basic consumer can read and correctly parse messages off the topic
- [x] CI runs both the decode test (Phase 1) and the schema test (Phase 2)

#### Live Demo

![Docker Compose and live ingestion](docs/img/phase2_compose.gif)
*Starts the GTFS streaming stack with Docker Compose, waits for Kafka to become healthy, then launches the ingestion service, continuously publishing MBTA vehicle telemetry.*

![Kafka round-trip integration test](docs/img/phase2_roundtrip.gif)
*Runs the Kafka round-trip integration test against the real broker. A test telemetry message is published through the production Kafka pipeline, consumed from raw.vehicle-positions, parsed as JSON, and validated against the expected schema.*

![Kafka round-trip integration test](docs/img/phase2_kafkaUI.png)
*Kafbat UI showing the raw.vehicle-positions Kafka topic populated with telemetry messages.*

### Phase 3 — Analytics Engine (Python + pandas)

**Goal: turn raw pings into real signal — but let the real data decide what "signal" means.**

This is the computational core. On startup, the engine loads GTFS-static schedule files (`stops.txt`, `trips.txt`, `stop_times.txt`) into memory, indexed by `trip_id` and `stop_id`, so every incoming real-time ping can be matched against where that vehicle was *supposed* to be.

**GTFS-static refresh strategy:** static schedule files change over time (MBTA pushes schedule updates), so loading them once at startup risks silent drift over a multi-week run. The engine checks MBTA's schedule version/checksum on a recurring interval (e.g. once a day) and reloads the static data when it changes, instead of assuming it's fixed for the life of the process.

Before writing any production logic, this phase starts with exploration: pulling a batch of real Kafka messages into a `pandas` DataFrame and actually looking at it — how noisy is the GPS data, how often do updates arrive, what does a "normal" delay distribution look like versus an outlier. That exploration is what decides which metrics are actually worth computing, rather than guessing upfront.

The MVP settles on two:

- **Schedule deviation** — comparing a vehicle's actual position/timestamp against its scheduled stop time to compute how late (or early) it's running.
- **Bunching detection** — checking spatial proximity between consecutive vehicles on the same route; if two buses that should be evenly spaced are instead close together, that's a real, well-known transit operations problem, and a more interesting signal than delay alone. 

Note: **The distance and time-window thresholds that define "too close together" are decided here, from real inspected MBTA spacing/headway patterns — not guessed in advance.** For example: two vehicles on the same route/direction within X meters, where the actual headway ratio is below Y times the scheduled headway. Real X/Y values get set once the exploration step above has actually happened.

Computed results are written to MongoDB. Schedule deviation documents are enriched with stop coordinates from GTFS-static data and indexed with a `2dsphere` geospatial index, so they can be queried by location later. Bunching events are persisted without location (a vehicle pair has no single natural location).

**Testing:** unit tests for the schedule-deviation calculation and the bunching-detection logic, run against fixed synthetic inputs with known expected outputs — this is where correctness matters most, since these numbers are the entire point of the project.

**Acceptance criteria:**
- [x] GTFS-static data loads correctly and is queryable by `trip_id`/`stop_id` — validated by `test_loader.py` (19 tests covering direction lookup, stop_times lookup, stops lookup, alphanumeric trip IDs, schema validation, atomic reload, version detection)
- [x] Static data refresh triggers correctly when the schedule version changes — validated by `test_loader.py::TestHasChanged` (feed_version change detection, file-fingerprint fallback, reload-if-changed)
- [x] Schedule deviation is computed correctly for a known real trip, spot-checked by hand — validated by `test_schedule_deviation.py` (12 tests covering GTFS time parsing, midnight-crossing resolution, timezone conversion, first-arrival collapsing, arrival/departure separation)
- [x] Bunching thresholds are set from real observed data — `DISTANCE_THRESHOLD_METERS=100` and `MIN_CONSECUTIVE_OBSERVATIONS=2`, set via notebook 04's sensitivity sweep (operationally anchored at ~5-8 bus-lengths; smooth gradient with no sharp cliff at this resolution)
- [x] Bunching detection correctly flags a known real bunched pair and does not flag a known well-spaced pair — validated by `test_bunching.py` (10 tests covering close-pair detection, direction exclusion, route exclusion, distance threshold, bucket-collision dedup, persistence requirement, event splitting)
- [x] Unit tests for metrics pass in CI — 94 unit tests across `test_schedule_deviation.py`, `test_bunching.py`, `test_loader.py`, `test_consumer.py`, `test_writer.py`; CI workflow: `analytics-tests.yml`
- [x] Computed deviation results carry stop coordinates for geospatial indexing — `DeviationResult.location` enriched from GTFS-static `stops_lookup` via `consumer.py::_enrich_with_location`; 2dsphere index created on `schedule_deviations.location` in `writer.py`; validated by `test_consumer.py::TestLocationEnrichment` (6 tests) and `test_integration.py::TestMongoDBPersistence::test_deviation_with_location_persists_geojson`
- [x] At-least-once delivery guarantee is implemented and tested — manual `commit(asynchronous=False)` gated on `persist_window` success; validated by `test_consumer.py::TestCommitGating` (5 tests covering success→commit, failure→skip, empty→skip, per-window gating, clean shutdown)
- [x] Integration tests verify real Kafka and MongoDB infrastructure — 8 tests in `test_integration.py` using testcontainers (Kafka roundtrip, MongoDB indexes/upserts/2dsphere, end-to-end pipeline); CI workflow: `python-integration-tests.yml`
- [X] Sustained-outage behavior and other known tradeoffs are documented — see [Known Limitations](#known-limitations) section and `docs/guarantees.md`

### Phase 4 — Serving API (TypeScript / Express)

**Goal: expose the computed metrics over a clean REST contract, and prove the whole pipeline end-to-end.**

A thin Express API that reads from MongoDB and exposes it externally. The MVP ships exactly one endpoint:

- `GET /v1/status/live` — current delay/bunching status for active vehicles.

The response contains three top-level fields: `delays` (schedule deviation entries), `bunching` (vehicle-pair proximity events), and `meta` (counts + timestamp for monitoring). Delays and bunching are separate arrays because they have different shapes and serve different consumers.

Kept deliberately minimal so the full pipeline — ingest → stream → analyze → serve — is proven working end-to-end before expanding the API surface. `/v1/routes/:id/reliability` (historical punctuality) and `/v1/bottlenecks` (speed-drop clustering) are real, planned additions once the MVP loop is solid — see Future Work below.

**Security posture:** read-only public endpoint serving public transit data. Applied measures: Helmet security headers, CORS, rate limiting (100 req/15min per IP via `express-rate-limit`), error sanitization (generic messages in production, full details in dev/test), request logging via pino.

**API as separate entry point:** the API server (`src/api/index.ts`) and the Kafka poller (`src/index.ts`) are different processes with different failure modes. The API is started via `npm run start:api`, the poller via `npm run dev`. They share the same MongoDB database but have independent lifecycles.

**Implementation details:**
- **MongoDB read connection:** `src/db/connection.ts` opens a dedicated connection with retry (same pattern as the analytics engine's `_connect_with_retry`), exposing `bunching_events` and `schedule_deviations` collections.
- **Router factory pattern:** `createStatusRouter(collections)` receives MongoDB collections via dependency injection, keeping the route handler testable without a real database.
- **Response mapping:** MongoDB documents are projected into typed response interfaces (`DelayEntry`, `BunchingEntry`, `LiveResponse`). Deviation documents that lack `route_id`/`direction_id` (not stored by the analytics engine) map those fields to `null` for a consistent response shape.

**Testing:**
- **Unit tests** (`tests/api/health.test.ts`, `tests/api/status.test.ts`): 10 tests covering health check, response shape with seeded mock data, empty database returns empty arrays, location null handling, ISO 8601 dates, error handling (500 on DB failure), and no-collections mode (404 when API starts without MongoDB).
- **Integration test** (`tests/integration/api.test.ts`): 6 tests using testcontainers — spins up a real MongoDB, seeds known documents, hits the endpoint via supertest, asserts response shape and data fidelity. Also tests the empty-database case and rate limiting (429 after threshold).
- **CI:** API unit tests run in the existing `unit-tests.yml` workflow (picked up by `vitest run --exclude tests/integration`). API integration tests run in `integration-tests.yml` alongside Kafka integration tests.

**Acceptance criteria:**
- [x] `GET /v1/status/live` returns real computed data from MongoDB
- [x] Integration test covers the endpoint's response shape with seeded test data
- [x] CI runs the full test suite (Phases 1–4) on every push
- [x] A recorded demo exists showing the live endpoint returning real MBTA-derived data

#### Live Demo

![Phase 4 Live API Demo](docs/img/phase4_demo.gif)
*Terminal recording showing `curl http://localhost:3000/v1/status/live` returning real, live MBTA-derived delay and bunching data. The response should show the `delays` array with vehicle deviations, the `bunching` array with vehicle-pair events, and the `meta` object with counts.*

### Phase 5 — Pre-Deployment Improvements

**Goal: make the deployed system useful from day one — enriched data and a visual demo.**

These improvements are done before deployment (Phase 6) so the system ships with human-readable route names and a live map.

**Step 1 — Route name enrichment.** The analytics engine now loads `routes.txt` from the GTFS-static bundle and builds two new lookups: `routes_lookup` (route_id → route_long_name) and `trip_route_lookup` (trip_id → route_id). The consumer attaches both `route_id` and `route_long_name` to deviation results before persisting to MongoDB. The enrichment is optional — if the lookup fails, the fields are `null` and the API falls back gracefully. Added to `loader.py`, `schedule_deviation.py` (DeviationResult dataclass), `consumer.py` (`_enrich_with_route_name`), `writer.py`, `types.ts`, and `status.ts`. Unit tests cover the new lookups (routes loading, NaN handling, missing columns, trip-to-route mapping) and the enriched consumer output.

**Step 2 — Live window filtering.** The `/v1/status/live` endpoint now filters out stale data using a 3-minute time window (`LIVE_WINDOW_MS`). Deviations are filtered by `actual_at >= cutoff`; bunching events by `end_time >= cutoff`. This prevents the map from accumulating historical markers that no longer represent current conditions. The window is set to 3× the analytics engine's processing interval (60s) to cover the current window buffer, one overlap cycle, and API polling jitter.

**Step 3 — Leaflet map.** A static HTML page served from Express at `/map` shows deviation markers and bunching events on a map of Boston using Leaflet basemap tiles. Deviation markers are color-coded by severity (green = on time, yellow = slightly late, red = very late, blue = early) and sized proportionally. Bunching events are visualized as paired purple markers (one per vehicle) connected by a dashed polyline, placed at the vehicles' last known deviation positions. Clicking a marker shows a popup with the route name, vehicle ID, and deviation. Clicking a bunching marker shows a table with route, vehicles, minimum distance, and duration. The stats panel shows live counts, last update time, and a data-age indicator that turns yellow (1.5 min) then red (3 min) when the data goes stale.

**Step 4 — Anti-flicker marker caching.** The map uses a client-side marker cache (`delayCache`, `bunchingCache`) instead of clearing and redrawing all markers on each refresh. Markers that briefly disappear from the API response (edge of the live window, processing lag) are dimmed to 35% opacity and kept on the map for up to 2 additional refresh cycles (60 seconds) before removal. This prevents the visual flickering caused by vehicles at the boundary of the 3-minute server-side time window.

**Step 5 — Frontend shape fixture tests.** A dedicated test file (`tests/api/map.test.ts`) builds a realistic API fixture and verifies the response shape matches what `map.js` consumes: every field the popup formatters read, valid GeoJSON coordinates, ISO 8601 timestamps, deviation color thresholds, and the bunching-vehicle cross-reference (matching `vehicle_a`/`vehicle_b` back to deviation locations). This catches API shape drift without needing a headless browser.

**Acceptance criteria:**
- [x] `GET /v1/status/live` returns `route_long_name` alongside `route_id`
- [x] `GET /v1/status/live` filters out data older than 3 minutes
- [x] `GET /map` serves the Leaflet map with deviation markers and bunching visualizations
- [x] Bunching popups show a table with route, vehicles, distance, and duration
- [x] Marker caching prevents flickering when vehicles cross the time window boundary
- [x] Unit tests pass for the new loader lookups, enriched response shape, and time-window filtering
- [x] Frontend shape fixture tests verify the API contract matches what map.js expects

#### Live Demo

![Phase 5 Leaflet Map](docs/img/phase5_map.png)
*Leaflet map showing deviation markers (colored by severity) and bunching events (purple markers) on a map of Boston. The stats panel displays live counts and a data-age indicator. Clicking a deviation marker shows the route name, vehicle ID, and deviation. Clicking a bunching marker shows a table with route, vehicles, minimum distance, and duration.*

### Phase 6 — Production Hardening & 24/7 Runtime (final step)

**Goal: stop running this project on a laptop. Deploy it somewhere that stays up, and let it actually collect real history.**

Everything before this phase can be developed and demoed locally, but "let it run and collect history" needs somewhere to actually run continuously.

- **Deployment target:** a small VPS or free-tier cloud VM, running the full stack (ingestion, Kafka, analytics engine, MongoDB, API) via Docker Compose. 
- **CI/CD close-out:** by this point CI (started in Phase 1) should be running the full test suite from every phase on every push.
- **Containerization:**  extending it to build and push Docker images automatically so deployment is a `docker compose pull && up` away, not a manual rebuild.
- **Let it run.** Once deployed, leave it running for a sustained period so the "Where the Data Could Go From Here" ideas below have something real to eventually build on, and so this README's numbers (uptime, records processed, delays observed) can be reported as real measured results instead of hypothetical ones.

**Acceptance criteria:**
- [ ] Full stack deployed via Docker Compose on a VPS/cloud VM, not running locally
- [ ] Pipeline has run continuously and unattended for at least several consecutive days
- [ ] CI runs the complete test suite (all phases) on every push
- [ ] This README's Status section is updated with real numbers: uptime achieved, records processed, and a GIF demo

## Known Limitations

These are deliberate, documented tradeoffs. They are the current state of an MVP that favors shipping working software over solving every edge case upfront.

**Sustained MongoDB outage triggers exponential backoff.** If MongoDB goes down for an extended period, the consumer's commit-gating (see `docs/guarantees.md`) prevents data loss by not advancing the Kafka offset. The consumer applies exponential backoff with jitter to persist retries, reducing CPU waste and log spam during prolonged outages. Backoff is configurable via `MONGO_RETRY_BASE_SECONDS` (default 1s), `MONGO_RETRY_MAX_SECONDS` (default 60s), and `MONGO_RETRY_JITTER_SECONDS` (default 1s). Kafka polling continues uninterrupted during backoff, preserving consumer-group membership. When MongoDB recovers, the backoff expires, the next persist attempt succeeds, and the consumer resumes normal operation. During the backoff window, the overlap buffer retains only the most recent pings (the last `OVERLAP_SECONDS`), so intermediate data from the deepest backoff period may be replayed from Kafka on restart rather than processed inline.

**Messages published during a consumer restart are missed.** The consumer uses `auto.offset.reset = "latest"`, meaning a restart picks up from the current tail of the topic. Any messages published between the last committed offset and the restart are not replayed. The alternative (`"earliest"`) would replay up to 72 hours of retained backlog on every restart, which is worse for an always-on consumer. The gap is accepted as a documented limitation for this MVP.

**Overlap boundary assumption.** The time-windowed-with-overlap strategy (see `consumer.py` module docstring) requires `OVERLAP_SECONDS >= MIN_CONSECUTIVE_OBSERVATIONS * POLL_INTERVAL_SECONDS`. The default configuration satisfies this exactly (30s = 2 × 15s), but with no extra margin. If either threshold changes without the other, boundary-crossing bunching events could be silently missed.

**Poll-interval bucket jitter can split continuous bunching events.** Real MBTA update cadence has jitter around the nominal 15-second interval (notebook 01 found a median of ~16s). Bucketing timestamps to a fixed poll-interval grid can split one real, continuous bunching event into two shorter ones if two vehicles' actual poll times straddle a bucket boundary. This is a known accuracy limitation, not a correctness bug.

**Departure deviations are disabled.** `compute_departure_deviations()` uses the last `STOPPED_AT` ping before a vehicle transitions away from a stop as a proxy for the actual departure moment. Unlike arrival-collapsing (which was validated in notebook 03), this specific technique was never checked against real data. It is disabled in `_process_window` pending: (1) empirical validation of the last-STOPPED_AT heuristic against ground truth, (2) a `MAX_DEVIATION` filter for ghost-shift outliers, and (3) re-adding the departure results to the deviation pipeline. The comment in `consumer.py` documents the re-enablement steps.

**No cross-document atomicity.** `persist_window` writes bunching events and schedule deviations in separate `bulk_write` calls. If the second write fails after the first succeeds, the Kafka offset is not committed, and the idempotent upsert design ensures the retry converges to the correct state — but the two collections are never atomically consistent within a single window. See `docs/guarantees.md` for the full delivery and persistence model.

## Where the Data Could Go From Here

The MVP is deliberately narrow, but the pipeline underneath it produces data with a lot of future potential once it's actually running and collecting history:

- **Historical reliability scoring** — aggregating punctuality per route over rolling time windows, surfaced through `/v1/routes/:id/reliability`, to answer "is this route usually on time" rather than just "is it late right now."
- **Bottleneck detection** — clustering locations where vehicle speeds consistently drop, exposed through `/v1/bottlenecks`, useful for spotting recurring congestion points rather than one-off delays.
- **Prediction accuracy tracking** — GTFS-RT trip updates include MBTA's *own* predicted arrival times; comparing those predictions against what actually happened over time is a low-infrastructure way to measure how trustworthy the agency's own ETAs really are, without needing to train a model from scratch.
- **Full silent-vehicle / feed-gap detection** — Phase 1 tracks per-vehicle last-seen timestamps; a dedicated alerting pass on top of that (flagging a vehicle that's gone quiet mid-service) is often a more actionable signal than a vehicle that's simply running late.
- **A dashboard** — the Leaflet map is the first version of this. A richer dashboard with historical trends, route-level comparisons, or real-time WebSocket updates is real future work on top of the map foundation.
- **A public weekly reliability report** — once enough historical data accumulates, a simple scheduled job could publish a "which routes were least reliable this week" summary, turning the pipeline from a live view into an ongoing dataset with its own long-term value.

## Repository Structure

Two independent services connected by Kafka — not a single app, and not per-agency adapter classes(yet), since this MVP targets one feed (MBTA) end-to-end rather than a pluggable multi-city aggregator. Structure mirrors the phases above directly.

```
gtfs-realtime-stream-engine/
├── docker-compose.yml            # Kafka, MongoDB
├── README.md
│
├── ingestion-service/             # Phases 1, 2, 4, 5 — TypeScript
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env                       # MBTA_API_KEY, MongoDB URI, Kafka broker (gitignored)
│   ├── src/
│   │   ├── index.ts                # Entry point: starts poller + Express API
│   │   ├── config.ts               # Poll interval, MBTA key, Mongo URI, Kafka broker
│   │   │
│   │   ├── proto/                    # The contract of the proto data
│   │   │   └── gtfs-realtime.proto        # GTFS Realtime Specification given by Google at github.com/google/transit/tree/master/gtfs-realtime
│   │   │
│   │   ├── generated/                    # Files generated using protobufjs-cli
│   │   │   ├── gtfs-realtime.js          # Static JavaScript file used to encode and decode the MBTA binary data
│   │   │   └── gtfs-realtime.d.ts        # TypeScript definitions
│   │   │
│   │   ├── ingestion/
│   │   │   ├── poller.ts           # Polls MBTA feed on interval (Phase 1)
│   │   │   ├── decoder.ts          # Protobuf → typed JSON (protobufjs)
│   │   │   ├── validator.ts        # Validate & skip malformed entries; track per-vehicle last-seen
│   │   │   └── producer.ts         # Publishes to Kafka raw.vehicle-positions (Phase 2; Phase 1 writes to Mongo directly instead)
│   │   │
│   │   ├── db/
│   │   │   └── connection.ts       # MongoDB read connection with retry (Phase 4)
│   │   │
│   │   ├── api/
│   │   │   ├── index.ts            # API entry point (Phase 4)
│   │   │   ├── server.ts           # Express app: helmet, cors, rate limiting
│   │   │   ├── types.ts            # Response type definitions
│   │   │   ├── routes/
│   │   │   │   └── status.ts       # GET /v1/status/live
│   │   │   └── middleware/
│   │   │       ├── rateLimiter.ts  # 100 req/15min per IP
│   │   │       └── errorHandler.ts # Sanitized error responses
│   │   │
│   │   ├── public/                   # Phase 5 — static files served by Express
│   │   │   ├── map.html              # Leaflet map page (OSM tiles, deviation markers)
│   │   │   └── map.js                # Map logic: fetch /v1/status/live, render markers
│   │   │
│   │   └── utils/
│   │       └── logger.ts           # Structured logging (poll failures, decode errors)
│   │
│   └── tests/
│       ├── config.test.ts
│       ├── decoder.test.ts
│       ├── poller.test.ts
│       ├── producer.test.ts
│       ├── setup-kafka.test.ts
│       ├── validator.test.ts
│       ├── api/
│       │   ├── health.test.ts      # Phase 4 — health check tests
│       │   ├── status.test.ts      # Phase 4/5 — response shape, filtering, error handling
│       │   └── map.test.ts         # Phase 5 — static file serving, frontend shape fixture
│       └── integration/
│           ├── kafka.test.ts       # Phase 2 — Kafka roundtrip (testcontainers)
│           └── api.test.ts         # Phase 4 — endpoint + MongoDB (testcontainers)
│
├── analytics-engine/               # Phases 3, 5 — Python
│   ├── pyproject.toml
│   ├── .env                        # Mongo URI, Kafka broker (gitignored)
│   ├── src/
│   │   ├── main.py                 # Entry point: wires config, writer, consumer, graceful shutdown
│   │   ├── config.py               # Environment-based configuration, fail-loud on missing values
│   │   │
│   │   ├── consumer.py             # Kafka consumer, time-windowed batching, dedup/update trackers
│   │   ├── gtfs_static/
│   │   │   ├── loader.py           # Atomic-reload GTFS-static loader, version-check refresh
│   │   │   └── refresh.py          # ETag-based GTFS ZIP download from MBTA
│   │   │
│   │   ├── metrics/
│   │   │   ├── schedule_deviation.py  # Arrival/departure deviation, GTFS time parsing
│   │   │   └── bunching.py            # Vectorized pair-finding, persistence-based detection
│   │   │
│   │   ├── db/
│   │   │   └── writer.py           # MongoDB upsert persistence, 2dsphere index on deviations
│   │   │
│   │   └── utils/
│   │       └── logger.py           # Structured logging
│   │
│   ├── notebooks/
│   │   ├── final/                   # Gate-passing, rerun against clean data
│   │   │   ├── 01_data_quality_and_frequency.ipynb
│   │   │   ├── 02_stop_matching.ipynb
│   │   │   ├── 03_schedule_deviation.ipynb
│   │   │   └── 04_bunching.ipynb
│   │   └── exploratory/             # Initial exploration drafts
│   │
│   └── tests/
│       ├── test_schedule_deviation.py
│       ├── test_bunching.py
│       ├── test_loader.py
│       ├── test_consumer.py
│       ├── test_writer.py
│       ├── test_refresh.py         # GTFS-static download/extract (mocked HTTP)
│       └── test_integration.py     # Kafka + MongoDB via testcontainers
│
├── docs/
│   ├── guarantees.md               # System guarantees: delivery, persistence, ordering
│   ├── analyticsEngineProcessingCycle.md  # How the consumer processes pings into metrics
│   ├── kafkaIntegrationTestExplanation.md # testcontainers readiness-gate strategy
│   └── img/
│       ├── phase1_demo.gif         # Phase 1 live ingestion demo
│       ├── phase1_mongo.png        # Phase 1 MongoDB view
│       ├── phase2_compose.gif      # Phase 2 Docker Compose demo
│       ├── phase2_roundtrip.gif    # Phase 2 Kafka roundtrip test
│       ├── phase2_kafkaUI.png      # Phase 2 Kafbat UI
│       └── phase4_demo.gif         # Phase 4 curl demo (PLACEHOLDER — record this)
│
└── .github/
    └── workflows/
        ├── unit-tests.yml          # CI: ingestion service unit tests
        ├── integration-tests.yml   # CI: Kafka integration (Docker Compose)
        ├── analytics-tests.yml     # CI: analytics engine lint + unit tests
        └── python-integration-tests.yml  # CI: analytics engine integration (testcontainers)
```

**Why two services and not one:** the whole architectural point of this project is that ingestion (TypeScript, I/O-bound polling) and analytics (Python, pandas/data-shape work) are genuinely different workloads decoupled by Kafka. `ingestion-service` also owns the serving API (Phase 4) and the Leaflet map (Phase 5), since it's the same runtime that already talks to MongoDB and Express; there's no reason to add a third service just to expose one endpoint or serve a static HTML page.

**Why no `adapters/` directory:** an earlier draft of this plan considered a pluggable adapter pattern for multiple transit agencies (TfL, BART, MBTA, CTA, etc.). That's explicitly out of scope for this MVP — one feed, done well, is the point (see MVP Scope above). If a second agency is ever added as real future work, `ingestion/poller.ts` and `decoder.ts` are the two files that would need an interface extracted from them at that time — not before there's a second real implementation to justify it.

## Data Flow Diagram

```mermaid
flowchart TD
    FEED["MBTA GTFS-Realtime Feed\nVehiclePositions (Protobuf)"]

    subgraph P1["Phase 1 — Ingestion Service (TypeScript)"]
        POLL["Poller\n(10-15s interval)"]
        DECODE["Protobuf Decoder\nprotobufjs / gtfs-realtime-bindings"]
        VALIDATE["Validate & Skip Malformed\n(log, don't crash)\nTrack per-vehicle last-seen"]
    end

    subgraph P2["Phase 2 — Event Streaming (Kafka)"]
        TOPIC["Kafka Topic\nraw.vehicle-positions"]
    end

    subgraph P3["Phase 3 — Analytics Engine (Python + pandas)"]
        CONSUME["Kafka Consumer\nconfluent-kafka"]
        STATIC["GTFS-Static Loader\n+ periodic refresh check"]
        JOIN["Join Real-time Ping\nvs Scheduled Stop Time"]
        DELAY["Compute: Schedule Deviation"]
        BUNCH["Compute: Bunching Detection\n(thresholds from real data)"]
    end

    subgraph STORE["Data Store — MongoDB"]
        BUNCHING[("bunching_events")]
        DEVIATIONS[("schedule_deviations\n(2dsphere on location)")]
    end

    subgraph P4["Phase 4 — Serving API (Express)"]
        API["GET /v1/status/live"]
        DEMO["curl / terminal demo\n+ Leaflet map (Phase 5)"]
    end

    subgraph P5["Phase 5 — Map, Enrichment & Filtering"]
        MAP["Leaflet Map\nGET /map\n(bunching viz, anti-flicker)"]
        ENRICH["Route Name Enrichment\nroute_long_name"]
        FILTER["Live Window Filter\n3-min cutoff on /v1/status/live"]
    end

    subgraph P6["Phase 6 — Production Hardening"]
        DEPLOY["Docker Compose\non VPS / cloud VM\nrunning 24/7"]
        CI["CI: full test suite\non every push"]
    end

    FEED --> POLL --> DECODE --> VALIDATE --> TOPIC
    TOPIC --> CONSUME
    STATIC --> JOIN
    CONSUME --> JOIN
    JOIN --> DELAY --> DEVIATIONS
    JOIN --> BUNCH --> BUNCHING
    DEVIATIONS --> API
    BUNCHING --> API
    API --> DEMO
    API --> MAP
    ENRICH --> DEVIATIONS
    FILTER --> API
    P1 -.-> CI
    P2 -.-> CI
    P3 -.-> CI
    P4 -.-> CI
    P1 -.-> DEPLOY
    P2 -.-> DEPLOY
    P3 -.-> DEPLOY
    P4 -.-> DEPLOY

    style P1 fill:#1e3a5f,color:#fff
    style P2 fill:#5f1e3a,color:#fff
    style P3 fill:#1e5f3a,color:#fff
    style P4 fill:#5f4a1e,color:#fff
    style P5 fill:#4a4a1e,color:#fff
    style P6 fill:#4a1e4a,color:#fff
```

*(Dashed arrows show CI and deployment applying across all build phases, closed out in Phase 6.)*

---

## ADRs


### Why use `vehicle_id` as the partition key?

Messages published to the `raw.vehicle-positions` topic are partitioned by the `vehicle_id`. This guarantees strict chronological ordering for telemetry belonging to the same physical vehicle. Simultaneously, it still allows for horizontal scaling and parallel processing across different vehicles, ensuring that data is both accurate and rapidly processed.

### Why default to 4 partitions for a single-broker MVP?

Even though the MVP runs on a single Kafka broker, the topic is initialized with 4 partitions. This decision ensures the architecture is already prepared to grow. When horizontal scalability is needed, new analytics consumers can be added to the consumer group, and Kafka will automatically rebalance the partitions across the new instances without requiring a topic recreation or downtime.

### Why use different Consumer Groups (e.g., Analytics and Alerting/Debug)?

Utilizing distinct consumer groups demonstrates that Kafka truly decouples consumers. By assigning the Python analytics engine to one group and an alerting/debug service to another, they process the exact same event stream completely independently. You can shut down the Analytics consumer and the Debug consumer will continue working uninterrupted.

### Why use KRaft instead of ZooKeeper?

The system utilizes KRaft (Kafka Raft) by configuring `KAFKA_PROCESS_ROLES=broker,controller`. This modern configuration eliminates the need for an external ZooKeeper dependency, allowing the node to manage its own metadata. It reduces the infrastructure footprint for deployment while proving an understanding of how the modern mode of Kafka works.

### Why decouple ingestion from processing via Kafka?

In traditional architectures, the ingestion service writes directly to the database. By placing Kafka in the middle, this system implements true backpressure. If the Python analytics engine crashes, requires a deployment, or gets bogged down by heavy Pandas computations, the Node.js ingestion service is unaffected. It continues to poll the MBTA feed at its 15-second interval, buffering the data in Kafka until the analytics engine recovers.