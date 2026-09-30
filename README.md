# GTFS Realtime Stream Engine

An event-driven pipeline that ingests, processes, and analyzes public transit telemetry. Deployed and running live at `http://157.90.113.98:3000/map`.

## Why This Project Exists

Many transit dashboard projects consume a pre-processed status API provided by the transit agency and render it directly, which gets working software in front of users quickly. This project takes a different path: it ingests **raw binary GTFS-Realtime feeds** (the Protobuf format transit agencies publish), decouples ingestion from processing with **Kafka**, and computes its own delay and bunching metrics. The goal is to demonstrate the full event-driven pipeline: ingestion, streaming, analytics, serving; rather than the visualization layer.

The pipeline itself is the core product. It runs continuously against live MBTA data and produces real metrics. A Leaflet map served from the same Express server shows the data in context, and a `curl`/terminal demo proves the API works. The data refreshes every ~30 seconds.

## Live Deployment

The full stack is deployed on a Hetzner CX23 (2 vCPU, 4GB RAM, €4.49/mo) running six containers via Docker Compose. The pipeline has been running unattended since 2026-09-25.

**Access:**
- Map: http://157.90.113.98:3000/map
- API: http://157.90.113.98:3000/v1/status/live

**Observed steady-state resource usage:**

| Container     | RAM      | CPU    |
|---------------|----------|--------|
| analytics     | ~1.6 GB  | 0.13%  |
| kafka         | ~460 MB  | 127%   |
| kafkabat-ui   | ~370 MB  | 0.03%  |
| mongodb       | ~370 MB  | 1.03%  |
| ingestion     | ~65 MB   | 4.55%  |
| api           | ~69 MB   | 0.14%  |

Kafka's high CPU is expected — the JVM reports total CPU across all threads, not per-core usage. MongoDB's I/O reflects the 72-hour retention window and the upsert-heavy write pattern.

For the full deployment runbook, see `docs/phase6-deployment-guide.md`.

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
                         (Leaflet map at /map
                          + curl / terminal demo)
```

**Five layers:**

1. **Ingestion (TypeScript):** Polls MBTA's raw Protobuf feed, decodes, validates, publishes to Kafka.
2. **Streaming (Kafka, KRaft mode):** Single broker, 4 partitions, decouples high-frequency ingestion from batch analytics.
3. **Analytics (Python + pandas):** Kafka consumer that joins real-time pings against GTFS-static schedules, computes schedule deviation and bunching detection.
4. **Storage (MongoDB):** Idempotent upserts with unique natural-key indexes. 2dsphere geospatial index on deviation locations.
5. **Serving API (Express):** REST endpoint exposing computed metrics, served alongside a Leaflet map.

## Tech Stack

| Layer | Technology | Responsibility |
|---|---|---|
| Ingestion | TypeScript, Node.js, `protobufjs` | Poll MBTA feed, decode Protobuf, validate, publish to Kafka |
| Event Broker | Apache Kafka, Docker | Decouple ingestion from analytics; buffer against feed hiccups |
| Analytics Engine | Python 3.12+, `confluent-kafka`, `pandas`, `numpy` | Join real-time pings against static schedule, compute delay/bunching |
| Data Store | MongoDB | Idempotent upserts; 2dsphere geospatial index on deviation locations |
| Serving API | TypeScript, Node.js, Express | REST endpoint exposing computed metrics |
| Runtime | Docker Compose, Hetzner CX23 VPS | Full stack running 24/7 on a single server |

## Build Phases

Each phase is a working, demoable checkpoint. Detailed implementation notes, acceptance criteria, and testing breakdowns are in [`docs/phases.md`](docs/phases.md).

### Phase 1 — Ingestion Service

Polls the MBTA feed every 15 seconds, decodes raw binary Protobuf into typed JSON, validates coordinates, and writes to MongoDB. Malformed entries are logged and skipped. Uses MongoDB compound unique indexes for idempotency. 193 tests across both services, CI on every push.

![Terminal Ingestion Demo](docs/img/phase1_demo.gif)

### Phase 2 — Event Streaming (Kafka)

Refactored ingestion to publish to Kafka instead of writing directly to Mongo. Decouples polling cadence from processing. Enables multiple independent consumers without touching ingestion code.

![Kafka round-trip integration test](docs/img/phase2_roundtrip.gif)

### Phase 3 — Analytics Engine

Python Kafka consumer that loads GTFS-static schedules, joins real-time pings against scheduled stop times, and computes two metrics: schedule deviation (how late is this bus) and bunching detection (are two buses on the same route within 100m for 30+ seconds). Thresholds set from real MBTA data, not guessed.

### Phase 4 — Serving API

Express API exposing `GET /v1/status/live` — current delays, bunching events, and metadata. Helmet security headers, CORS, rate limiting, error sanitization. Separate entry point from the poller with independent lifecycle.

![Phase 4 Live API Demo](docs/img/phase4_demo.gif)

### Phase 5 — Map, Enrichment & Anti-Flicker

Leaflet map showing deviation markers (color-coded by severity) and bunching events (purple pairs with dashed polylines) on a map of Boston. Route name enrichment, 3-minute live window filtering, client-side marker caching to prevent flickering. Info panel explaining the pipeline to visitors.

![Phase 5 Leaflet Map](docs/img/phase5_map.png)

### Phase 6 — Production Deployment

Deployed on Hetzner CX23 via Docker Compose. Three Dockerfiles with multi-stage builds. MongoDB pinned to 7.0 (kernel 6.19 compat). Resource limits: Kafka 256MB heap, MongoDB 256MB cache. UFW firewall. Running unattended since 2026-09-25.

Full runbook: [`docs/phase6-deployment-guide.md`](docs/phase6-deployment-guide.md)

## Known Limitations

These are deliberate, documented tradeoffs. Detailed explanations are in [`docs/phases.md`](docs/phases.md) and [`docs/guarantees.md`](docs/guarantees.md).

- **Sustained MongoDB outage triggers exponential backoff.** Consumer applies backoff with jitter; Kafka polling continues. Recovery is automatic.
- **Messages published during a consumer restart are missed.** `auto.offset.reset = "latest"` — accepted as a documented gap for this MVP.
- **Overlap boundary assumption.** `OVERLAP_SECONDS >= MIN_CONSECUTIVE_OBSERVATIONS * POLL_INTERVAL_SECONDS` — satisfied exactly, with no margin.
- **Poll-interval bucket jitter can split continuous bunching events.** Real MBTA cadence has ~16s median jitter against the nominal 15s interval.
- **Departure deviations are disabled.** The last-STOPPED_AT heuristic was never validated against real data. Disabled pending empirical validation.
- **No cross-document atomicity.** Bunching and deviation writes are separate `bulk_write` calls. Idempotent upserts ensure retry convergence.

## How to Run

### Local — Infrastructure in Docker, Services in Terminal

This setup runs only Kafka and MongoDB as Docker containers, and the three application services (ingestion, API, analytics) as separate terminal processes. It's the best option for debugging: you get live logs in each terminal, can attach a debugger to any service, and restart a single service without waiting for a Docker build.

**Prerequisites:** Node.js 20+, Python 3.12+, [uv](https://docs.astral.sh/uv/), Docker.

**1. Start infrastructure:**

```bash
docker compose up -d mongodb kafka
```

**2. Create `.env` files** (one per service, copied from the `.env.example`
files already in the repo):

```bash
cp ingestion-service/.env.example ingestion-service/.env
cp analytics-engine/.env.example analytics-engine/.env
```

Both files point to `localhost` because the Docker Compose ports are
mapped to `127.0.0.1` (MongoDB on 27017, Kafka on 9092).

**3. Install dependencies:**

```bash
cd ingestion-service && npm install && cd ..
cd analytics-engine && uv sync && cd ..
```

**4. Start each service in its own terminal:**

```bash
# Terminal 1 — Ingestion (polls MBTA feed, publishes to Kafka)
cd ingestion-service && npm run dev

# Terminal 2 — API (serves /v1/status/live and /map)
cd ingestion-service && npm run start:api

# Terminal 3 — Analytics (consumes Kafka, computes metrics, writes to MongoDB)
cd analytics-engine && uv run python src/main.py
```

The map is at `http://localhost:3000/map` and the API at
`http://localhost:3000/v1/status/live`.

**Why this approach:** each service runs directly on the host, so changes to source code take effect on the next restart, so no Docker build step is required. If you're iterating on the analytics engine's bunching detection logic, for example, you edit the Python file, `Ctrl+C` the analytics terminal, run it again, and see the result immediately.

### Local — Running as Docker Compose (all containers)

If you just want to see the full stack running without touching terminals:

```bash
docker compose up -d
```

This starts all six containers (Kafka, MongoDB, Kafbat UI, ingestion, API, analytics). The map is at `http://localhost:3000/map`.

**Important: after making code changes, the running containers will still be running the old code.** Docker images are built once at `up` time. If you edit source files and want the containers to pick up the changes, you must rebuild:

```bash
docker compose up -d --build
```

Without `--build`, Docker reuses the existing images and your changes are invisible.

### Production Server

After pushing changes to `main`, SSH in, pull, and rebuild:

```bash
cd ~/workspace/GTFS-Realtime-Stream-Engine
git pull origin main
docker compose up -d --build
docker image prune -f
```

`docker compose up -d` alone (without `--build`) restarts containers but keeps the old images. `--build` forces Docker to rebuild the images from the updated source before replacing the running containers.

To verify the deploy worked:

```bash
curl http://localhost:3000/v1/status/live
```

## Repository Structure

```
gtfs-realtime-stream-engine/
├── docker-compose.yml            # Full stack: Kafka, MongoDB, ingestion, API, analytics
├── README.md
│
├── ingestion-service/             # Phases 1, 2, 4, 5 — TypeScript
│   ├── .env.example              # Required env vars (copy to .env)
│   ├── Dockerfile                # Multi-stage: poller (dist/src/index.js)
│   ├── Dockerfile.api            # Multi-stage: API + static map files
│   ├── .dockerignore
│   ├── src/
│   │   ├── index.ts                # Entry point: starts poller
│   │   ├── config.ts               # Environment-based configuration
│   │   ├── proto/                    # GTFS-Realtime Protobuf specification
│   │   ├── ingestion/                # Poller, decoder, validator, Kafka producer
│   │   ├── db/                       # MongoDB read connection (Phase 4)
│   │   ├── api/                      # Express API: server, routes, middleware (Phase 4)
│   │   ├── public/                   # Leaflet map files (Phase 5)
│   │   └── utils/                    # Structured logging
│   └── tests/                        # 135 tests: unit + integration (testcontainers)
│
├── analytics-engine/               # Phases 3, 5 — Python
│   ├── .env.example              # Required env vars (copy to .env)
│   ├── Dockerfile                # Python 3.12-slim + uv, two-phase dep install
│   ├── .dockerignore
│   ├── src/
│   │   ├── main.py                 # Entry point: wires config, writer, consumer
│   │   ├── consumer.py             # Kafka consumer, time-windowed batching
│   │   ├── gtfs_static/            # GTFS-static loader + periodic refresh
│   │   ├── metrics/                # Schedule deviation + bunching detection
│   │   ├── db/                     # MongoDB upsert persistence
│   │   └── utils/                  # Structured logging
│   ├── notebooks/                  # Jupyter exploration (01-04)
│   └── tests/                      # 137 tests: unit + integration (testcontainers)
│
├── docs/
│   ├── phases.md                 # Detailed phase documentation + ADRs
│   ├── phase6-deployment-guide.md  # Production deployment runbook
│   ├── guarantees.md               # System guarantees: delivery, persistence, ordering
│   ├── multi-agency-vision.md      # Long-term: multi-agency platform + JWT
│   └── img/                        # Demo screenshots and GIFs
│
└── .github/
    └── workflows/                  # CI: unit tests, integration tests (both services)
```

**Why two services and not one:** ingestion (TypeScript, I/O-bound polling) and analytics (Python, pandas/data-shape work) are genuinely different workloads decoupled by Kafka. `ingestion-service` also owns the serving API and the Leaflet map since it's the same runtime that already talks to MongoDB and Express.

**Why no `adapters/` directory:** one feed, done well, is the point. If a second agency is ever added, `ingestion/poller.ts` and `decoder.ts` are the two files that would need an interface extracted — not before there's a second real implementation to justify it.

## Documentation

| Document | Description |
|---|---|
| [`docs/phases.md`](docs/phases.md) | Detailed implementation notes, acceptance criteria, and testing breakdowns for each build phase (1–6). Also contains the Architecture Decision Records (ADRs). |
| [`docs/phase6-deployment-guide.md`](docs/phase6-deployment-guide.md) | Production deployment runbook for the Hetzner CX23 — Docker Compose setup, resource limits, UFW firewall, issues encountered, and step-by-step deploy commands. |
| [`docs/guarantees.md`](docs/guarantees.md) | System guarantees and documented tradeoffs — delivery semantics, persistence strategy, ordering guarantees, and what happens during failures. |
| [`docs/analyticsEngineProcessingCycle.md`](docs/analyticsEngineProcessingCycle.md) | Explains how the analytics engine's consumer loop works — time-windowed batching, overlap strategy, commit gating, and the lifecycle of a processing window. |
| [`docs/kafkaIntegrationTestExplanation.md`](docs/kafkaIntegrationTestExplanation.md) | How the Kafka round-trip integration test works using testcontainers — spinning up a real broker, publishing, consuming, and verifying the message in CI. |
| [`docs/number-flow-explained.md`](docs/number-flow-explained.md) | Why the stats panel, the API response, and the map show different counts — what each number represents and where it comes from in the pipeline. |
| [`docs/multi-agency-vision.md`](docs/multi-agency-vision.md) | Long-term vision for turning the single-MBTA pipeline into a multi-agency platform with configurable connectors. |
