# Incident postmortems

One file per incident, named `YYYY-MM-DD-<slug>.md` for the day the incident
began (UTC). Compiled 2026-11-08 from operational records and data queries
against the running stack. Counts and numbers are grounded in
`route_hourly_stats`, the raw/parquet archive, MongoDB and container logs
wherever those sources exist.

## Template

Every file follows the same shape:

- **Summary**: one line: what broke, how it surfaced, how bad.
- **Timeline**: UTC unless noted.
- **Evidence**: concrete data: log lines, SQL results, counts.
- **Root cause**: the mechanism, not the symptom.
- **Fix**: what changed, and its status (deployed / open).
- **Alert that would have caught it**: judged against the alerting in place
  today (the Healthchecks.io dead-man ping, `alerting.py` rules 1 and 2, and
  the daily ops report), noting when the alert did not yet exist at incident
  time.

## Index

| File | Severity | Status |
|---|---|---|
| [2026-10-05-mongodb-missing-restart-policy.md](2026-10-05-mongodb-missing-restart-policy.md) | SEV1 (crash-loop after reboot) | fixed |
| [2026-10-05-api-latency-missing-indexes.md](2026-10-05-api-latency-missing-indexes.md) | SEV2 (10 s searches) | fixed |
| [2026-10-05-analytics-memory-blowup.md](2026-10-05-analytics-memory-blowup.md) | SEV2 (1.5 GB RSS on a 4 GB host) | fixed |
| [2026-10-24-empty-history-scare.md](2026-10-24-empty-history-scare.md) | none (no data loss; UX bug) | UX fix open |
| [2026-10-24-route-id-case-sensitivity.md](2026-10-24-route-id-case-sensitivity.md) | SEV3 (search returns 0) | **open** |
| [2026-10-25-kafka-healthcheck-cpu-burn.md](2026-10-25-kafka-healthcheck-cpu-burn.md) | SEV2 (one core burned 24/7) | fixed |
| [2026-10-25-kafka-data-in-container-layer.md](2026-10-25-kafka-data-in-container-layer.md) | SEV1 (latent wipe hazard) | fixed |
| [2026-10-26-archive-consumer-zombie-outage.md](2026-10-26-archive-consumer-zombie-outage.md) | SEV1 (4-day silent outage) | fixed + backfilled |
| [2026-10-26-external-review-hardening.md](2026-10-26-external-review-hardening.md) | SEV3 (hardening gaps) | mostly fixed |
| [2026-10-29-backfill-container-instant-exit.md](2026-10-29-backfill-container-instant-exit.md) | SEV3 (tooling) | fixed |
| [2026-10-29-compactor-duckdb-oom.md](2026-10-29-compactor-duckdb-oom.md) | SEV2 (compactor produced 0 files) | fixed |
| [2026-10-29-root-owned-scratch-files.md](2026-10-29-root-owned-scratch-files.md) | SEV3 (cleanup blocked) | fixed |
| [2026-11-01-service-date-and-dst.md](2026-11-01-service-date-and-dst.md) | **SEV1 (silent data loss, 6 days)** | fixed |
| [2026-11-01-mongo-unbounded-growth.md](2026-11-01-mongo-unbounded-growth.md) | SEV2 (disk growth ~30 MB/day) | fixed |
| [2026-11-01-disk-pressure.md](2026-11-01-disk-pressure.md) | SEV2 (disk at 84%) | fixed; parquet retention still open |
| [2026-11-04-analytics-exdev-crashloop.md](2026-11-04-analytics-exdev-crashloop.md) | SEV1 (deploy crash-loop) | fixed |
| [2026-11-04-bunching-false-positives.md](2026-11-04-bunching-false-positives.md) | SEV2 (bogus bunching numbers) | fixed |
| [2026-11-05-monitoring-agent-outage.md](2026-11-05-monitoring-agent-outage.md) | SEV2 (monitoring blind) | fixed |
| [2026-11-08-raw-pruning-stalled.md](2026-11-08-raw-pruning-stalled.md) | SEV2 (disk at 90%) | fixed |

## Non-incidents and minor notes (not filed)

- **`TimeoutNegativeWarning: -<epoch>ms`** at `gtfs_ingestion` startup: benign
  kafkajs 2.2.4 quirk (`scheduleCheckPendingRequests()` computes a negative
  timeout when the pending request queue is empty; Node clamps it to 1 ms and
  warns once per process). No fix needed.
- **Kafka "94% CPU" (2026-10-09)**: transient JVM reporting quirk,
  self-resolved within hours.
- **`gtfs_ingestion` prod app logs are swallowed** (`src/utils/logger.ts`
  ships pino with `transport: { targets: [] }`): observability defect,
  **open**. Kafkajs errors still surface on stdout, and container activity can
  be verified via Kafka offsets.
