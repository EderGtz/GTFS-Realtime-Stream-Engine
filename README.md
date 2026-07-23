# GTFS Realtime Stream Engine

An event-driven pipeline that ingests, processes, and analyzes real-time public transit telemetry.

## Why This Project Exists

Most "real-time transit dashboard" projects call a pre-digested status API (like the ones provided by Transport For London or  Bay Area Rapid Transit) and render it on a map. This one doesn't. It ingests **raw binary GTFS-Realtime feeds** (the actual protobuf format transit agencies publish), decouples ingestion from processing with **Kafka**, and computes its own delay and bunching metrics instead of trusting someone else's summary.

The goal isn't just a portfolio piece — it's to actually build an end-to-end event-driven system using real public data instead of mocked data, and to let a frontend layer close the loop by turning that pipeline into something a person can actually look at and use.

## Architecture Overview

```
                        [ GTFS-Realtime Feeds ]
                                  │
                                  ▼
        ┌──────────────────────────────────────────────┐
        │     ingestion-service (TypeScript)            │
        │  - Polls agency feeds on an interval           │
        │  - Decodes Protobuf → typed JSON                │
        │  - Publishes to Kafka                            │
        └───────────────────────┬────────────────────────┘
                                  │  (Kafka event stream)
                       ┌──────────────────────┐
                       │     Apache Kafka      │
                       │  raw.vehicle-positions │
                       │  raw.trip-updates      │
                       └──────────┬─────────────┘
                                  │  (consumer group)
        ┌──────────────────────────────────────────────┐
        │     analytics-engine (Python + pandas)         │
        │  - Loads GTFS-static schedule data              │
        │  - Joins real-time pings against schedule        │
        │  - Computes delay & bunching metrics              │
        └───────────────────────┬────────────────────────┘
                                  │  (persisted metrics)
                       ┌──────────────────────┐
                       │       MongoDB         │
                       │  vehicle_telemetry     │
                       │  route_analytics       │
                       └──────────┬─────────────┘
                                  │
        ┌──────────────────────────────────────────────┐
        │       public-api (TypeScript / Express)        │
        │  - Serves computed delays & analytics            │
        └───────────────────────┬────────────────────────┘
                                  │
        ┌──────────────────────────────────────────────┐
        │       dashboard (React)                          │
        │  - Live map of vehicles, delays, and bunching     │
        └──────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Responsibility |
|---|---|---|
| Ingestion | TypeScript, Node.js, `protobufjs` | Poll GTFS-RT feeds, decode binary Protobuf into typed objects, publish to Kafka |
| Event Broker | Apache Kafka, Docker | Decouple ingestion cadence from analytics processing; buffer against agency API hiccups |
| Analytics Engine | Python 3.11+, `confluent-kafka`, `pandas`, `shapely` | Join real-time pings against static schedule data, compute delay/bunching, explore the data before finalizing metrics |
| Data Store | MongoDB | Geospatially indexed (`2dsphere`) telemetry and analytics storage |
| Serving API | TypeScript, Node.js, Express | REST endpoints exposing computed metrics |
| Dashboard | React | Live visualization of vehicles, delays, and bunching on a map |

## MVP Scope — What v1 Will Actually Cover

The MVP is scoped deliberately small and built in order, with each phase a working, demoable checkpoint on its own:

- **One transit agency, one feed type to start** (vehicle positions), not the full GTFS-RT spec.
- **Two computed metrics** — schedule deviation (is a vehicle late, and by how much) and bunching detection (are two vehicles on the same route too close together) — not the full list of possible analytics. More metrics get added once real data has actually been looked at, not designed on paper in advance.
- **One serving endpoint** (`/v1/delays/live`) before building out reliability history or bottleneck detection.
- **A minimal dashboard** — a live map showing current vehicle positions and delay status — not a full analytics UI with historical charts, at least not in v1.

Everything else in the original full architecture (trip-update feeds, historical reliability windows, bottleneck clustering, a polished UI) is real future work, described at the end of this README, not part of the MVP.

## Build Phases

### Phase 1 — Ingestion Service (TypeScript)

**Goal: get real data flowing end-to-end as fast as possible, before building anything else.**

This phase polls a single live GTFS-Realtime `VehiclePositions` feed on an interval (every 10–15 seconds), decodes the raw Protobuf payload into a typed JSON object using `protobufjs`, and — deliberately, at this stage — writes it straight into MongoDB. No Kafka yet.

Skipping Kafka here isn't cutting a corner; it's intentional sequencing. The whole point of this phase is to get a fast feedback loop: see what a real feed actually looks like (field naming quirks, update frequency, how noisy the GPS coordinates are, how agencies handle missing data) before making any decisions about how that data should be partitioned, buffered, or processed downstream. Adding Kafka before understanding the data would mean designing the event schema blind.

By the end of Phase 1, there should be a small but real collection of live vehicle position documents in MongoDB, pulled from an actual transit agency, decoded from raw binary Protobuf — proof that the hardest part (talking to a real, undocumented-in-practice binary feed) works.

### Phase 2 — Event Streaming Layer (Apache Kafka)

**Goal: introduce the decoupling layer, now that the data shape is understood.**

Once Phase 1 has produced real, inspected data, the ingestion service is refactored to publish to Kafka instead of writing directly to Mongo — `raw.vehicle-positions` as the first topic. Kafka sits between ingestion and everything downstream so that:

- Ingestion can keep polling at its own pace even if analytics processing is temporarily slow or down.
- A feed hiccup or agency outage doesn't take down anything else in the system.
- More consumers can be added later (an alerting service, a logging service, a second analytics variant) without ever touching the ingestion code again.

### Phase 3 — Analytics Engine (Python + pandas)

**Goal: turn raw pings into real signal — but let the real data decide what "signal" means.**

This is the computational core. On startup, the engine loads GTFS-static schedule files (`stops.txt`, `trips.txt`, `stop_times.txt`) into memory, indexed by `trip_id` and `stop_id`, so every incoming real-time ping can be matched against where that vehicle was *supposed* to be.

Before writing any production logic, this phase starts with exploration: pulling a batch of real Kafka messages into a `pandas` DataFrame and actually looking at it — how noisy is the GPS data, how often do updates arrive, what does a "normal" delay distribution look like versus an outlier. That exploration is what decides which metrics are actually worth computing, rather than guessing upfront.

The MVP settles on two:

- **Schedule deviation** — comparing a vehicle's actual position/timestamp against its scheduled stop time to compute how late (or early) it's running.
- **Bunching detection** — checking spatial proximity between consecutive vehicles on the same route; if two buses that should be evenly spaced are instead close together, that's a real, well-known transit operations problem, and a more interesting signal than delay alone.

Computed results are written to MongoDB with a `2dsphere` geospatial index, so they can be queried by location later.

### Phase 4 — Serving API (TypeScript / Express)

**Goal: expose the computed metrics over a clean REST contract.**

A thin Express API that reads from MongoDB and exposes it externally. The MVP ships exactly one endpoint:

- `GET /v1/delays/live` — current delay/bunching status for active vehicles.

Kept deliberately minimal so the full pipeline — ingest → stream → analyze → serve — is proven working end-to-end before expanding the API surface. `/v1/routes/:id/reliability` (historical punctuality) and `/v1/bottlenecks` (speed-drop clustering) are real, planned additions once the MVP loop is solid — see Future Work below.

### Phase 5 — Dashboard (React)

**Goal: make the pipeline visible and usable.**

A frontend was deliberately left out of the original architecture sketch, which was a mistake — a real-time backend with nowhere to look at the output isn't much of a demo. The MVP dashboard will be intentionally simple: a live map (e.g. via Leaflet) showing current vehicle positions, colored by delay status, with bunched vehicles flagged. It consumes `/v1/delays/live` on a polling interval. No auth, no historical charts, no route search — just the live map, built with actual state management and componentization, not a static HTML page.

## Where the Data Could Go From Here

The MVP is deliberately narrow, but the pipeline underneath it produces data with a lot of future potential once it's actually running and collecting history:

- **Historical reliability scoring** — aggregating punctuality per route over rolling time windows, surfaced through `/v1/routes/:id/reliability`, to answer "is this route usually on time" rather than just "is it late right now."
- **Bottleneck detection** — clustering locations where vehicle speeds consistently drop, exposed through `/v1/bottlenecks`, useful for spotting recurring congestion points rather than one-off delays.
- **Prediction accuracy tracking** — GTFS-RT trip updates include the agency's *own* predicted arrival times; comparing those predictions against what actually happened over time is a low-infrastructure way to measure how trustworthy an agency's own ETAs really are, without needing to train a model from scratch.
- **Silent-vehicle / feed-gap detection** — tracking per-vehicle heartbeats and flagging when a vehicle stops reporting mid-service, which is often a more actionable signal than a vehicle that's simply running late.
- **A richer dashboard** — historical trend charts per route, a searchable route view, and eventually push-based updates (WebSockets) instead of polling.
- **A public weekly reliability report** — once enough historical data accumulates, a simple scheduled job could publish a "which routes were least reliable this week" summary, turning the pipeline from a live view into an ongoing dataset with its own long-term value.

## Status

🚧 Early build — Phase 1 in progress.
