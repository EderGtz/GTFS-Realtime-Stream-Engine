# Archive Consumer

**Status: IMPLEMENTED**. Everything in the "Design", "Semantics",
and "Operations" sections below is built and tested. The "Planned" section at
the end describes future work that does **not** exist yet.

A standalone Go service that consumes the same `raw.vehicle-positions` Kafka
topic as the analytics engine, as a **second, independent consumer group**
(`archive-group`), and appends every message verbatim to date-partitioned
NDJSON files. This is just pure I/O: no parsing, no transformation, no metrics.

The analytics engine can be rewritten or die entirely and the archive keeps writing. It also extends history beyond
Kafka's 72-hour retention (`KAFKA_LOG_RETENTION_HOURS` in docker-compose.yml).

```
                       ┌────────────────────────┐
                       │     Apache Kafka       │
                       │  raw.vehicle-positions │
                       └──────────┬─────────────┘
                                  │  (archive-group)
                       ┌──────────▼─────────────┐
                       │   archive-consumer     │
                       │   (Go, pure I/O)       │
                       └──────────┬─────────────┘
                                  ▼
              data/archive/YYYY-MM-DD/HH.ndjson(.gz)   (UTC)
```

Code lives in `archive-consumer/`:

| File | Responsibility |
|---|---|
| `main.go` | Wiring: config → writer → kafka.Reader → consume loop; SIGTERM/SIGINT graceful shutdown; minute-level stats log |
| `config.go` | Fail-loud env config (same discipline as `ingestion-service/src/config.ts`) |
| `writer.go` | NDJSON writer: hourly rotation, gzip finalization, crash-safe rename |
| `archive.go` | Consume loop: batch → write → fsync → commit (at-least-once) |
| `env.go` | Minimal `.env` loader for local dev |
| `archive_integration_test.go` | Real-Kafka test (testcontainers, KRaft): round-trip, decoupling, restart behavior |

## File layout

```
data/archive/                  ← bind-mounted to /data/archive in compose
  2026-10-20/
    00.ndjson.gz               ← closed hour, gzipped exactly once
    01.ndjson                  ← active hour: plain, appendable
```

- One Kafka message = one NDJSON line, **byte-identical** to the value
  ingestion-service published (`producer.ts` `publishTelemetries`).
- Partitioned by **write time (UTC)**, not event time — see decisions below.
- The active hour's file stays plain so a crash can never corrupt it and a
  restart can append to it. Each file is gzipped to `.ndjson.gz` exactly once,
  when its hour is definitely over (at rotation or at the next startup).

## Semantics

**At-least-once, same as the rest of the pipeline** (see `docs/guarantees.md`
§7). The loop batches up to 500 messages or 1 second, then: write all lines →
flush + fsync → commit offsets. If anything fails before the commit, nothing
is committed and Kafka redelivers after restart. Consequences:

- **Duplicates are possible** (a crash between fsync and commit redelivers the
  batch → those lines appear twice). Accepted; the file layer has no dedup.
- **No data loss** from consumer-side failures: uncommitted = redelivered.

**Crash and recovery story:**

- Crash mid-write → the plain file ends with at most one partial line; all
  previous lines are intact (this is why the active file is plain, not gz).
- Crash mid-gzip → gzip uses tmp + atomic rename; a complete `.gz` at the final
  name is always valid. If both `HH.ndjson` and `HH.ndjson.gz` exist (crash
  between rename and removal), startup keeps the `.gz` and drops the plain file.
- Restart within the same hour → appends to the existing plain file.
- Restart later → startup gzips every stale plain file whose hour is over.

## Design decisions (the WHY)

| Decision | Why |
|---|---|
| `segmentio/kafka-go`, not `confluent-kafka-go` | Pure Go (no cgo/librdkafka build chain), static binary, tiny image. At MBTA volume (~40 msg/s) performance differences are irrelevant; the 4GB server matters more. |
| Verbatim NDJSON, no envelope | Pure I/O: the writer appends bytes it never looks at, so nothing in this service can alter data. Each line is replayable to Kafka as-is and readable with `zcat`/`jq`/`tail -f`. An offset/partition envelope was rejected as transformation creep. |
| Partition by write time (UTC) | No per-message parsing; rotation is just the clock. Event-time partitioning would require parsing every message and reopening old files for late arrivals. Trade-off: a manual `earliest` backfill lands 72h of history into the *current* hour's file. |
| Hourly rotation | ~43MB/hour raw at MBTA volume — big enough to avoid the small-files/inode problem many tiny archives hit, small enough for `zgrep`/DuckDB to target a day. |
| gzip on close, not streamed | A crash mid-hour leaves a *valid partial* plain file. Streaming gzip would leave one corrupt `.gz` and lose the hour. gzip (stdlib) over zstd: universally readable; at ~150-250MB/day the extra ~30% ratio of zstd buys little. Swap later if disk ever becomes scarce. |
| Manual commit after fsync | The at-least-once contract: nothing is acknowledged to Kafka until it is durable on disk. |
| `ARCHIVE_AUTO_OFFSET_RESET=latest` default | Matches the documented gap of the analytics consumer (`docs/guarantees.md` §6) — one consistent behavior across the system. `earliest` is the manual backfill switch (first run only; after that the group resumes from its own commits). |
| Batch 500 msgs / 1s | Bounds duplicate windows and syscall count; 1s caps latency before a low-traffic batch reaches disk. |
| Non-root container (uid 10001) | The service only needs write access to one directory; least privilege. |

## Operations

**Host run (local dev):**

```bash
docker compose up -d kafka
cd archive-consumer && cp .env.example .env   # points at localhost:9092 and ../data/archive
go run .
```

**Compose (production):** the `archive` service in docker-compose.yml.
One prerequisite on first deploy — the bind-mounted dir must be writable by
the container user (uid 10001):

```bash
mkdir -p data/archive && sudo chown 10001:10001 data/archive
```

**Environment variables** (see `archive-consumer/.env.example`):
`KAFKA_BROKERS` (mandatory), `KAFKA_TOPIC`, `KAFKA_GROUP_ID`, `ARCHIVE_DIR`,
`ARCHIVE_AUTO_OFFSET_RESET`.

**Disk budget:** ~43MB/hour raw, ~150-250MB/day gzipped. On the 40GB Hetzner
disk that is months of headroom. There is **no retention/pruning** yet.

**Replay:** `zcat data/archive/*/*.ndjson.gz | jq ...` for analysis;
re-publishing a day to Kafka is a small script over the raw lines (each line is
the original message value).

## Reference research

Design informed by two real archivers (researched 2026-10-07):

- [Kurt Raschke, "GTFS-realtime archiver design considerations"](https://kurtraschke.com/2025/12/gtfs-realtime-archiver-design)
  — surveys binary/relational/tabular/JSON archival models. Takeaways applied
  here: raw-on-disk is the right minimal-infra tier; a crash must never corrupt
  a whole hour (→ plain-while-active + atomic rename); hourly files avoid the
  many-small-files/inode trap.
- [JarvusInnovations/gtfs-realtime-archiver](https://github.com/JarvusInnovations/gtfs-realtime-archiver)
  (gtfsrt.io) — raw-first storage with daily downstream compaction to Parquet.
  That two-stage shape is exactly the planned phase below.

## Known limitations

- **Duplicate lines after a crash** (between fsync and offset commit). By
  design of at-least-once; no dedup layer exists.
- **Write-time partitioning**: files are organized by when the archive wrote
  the message, not when the vehicle moved. Fine for the main use case (rolling
  history); a problem only for event-time backfills.
- **No retention policy**: files accumulate until disk says otherwise.
- **Single writer per directory**: one consumer process per `ARCHIVE_DIR`.

## Planned — NOT implemented: daily compaction to Parquet

A second service (`archive-compactor/`, Python + DuckDB — both already
analytics-engine dependencies) will fold complete days of NDJSON into one
Hive-partitioned zstd Parquet file (`data/archive/parquet/date=YYYY-MM-DD/`),
keeping a verbatim `raw` column for fidelity and schema evolution, then delete
the raw day **only after row-count verification** (with a configurable grace
period). Eligibility: days older than 48h whose hourly files are all finalized.
Rationale: the raw tier is optimized for safe I/O, the Parquet tier for cheap
historical analysis — the same raw-first-then-compact shape Jarvus runs in
production. Until that exists, the gzipped NDJSON *is* the historical store.
