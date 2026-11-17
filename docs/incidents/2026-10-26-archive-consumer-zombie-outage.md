# Go archive consumer zombied: 4-day silent pipeline outage

**Date:** 2026-10-26 05:19 to 2026-10-30 (discovered 2026-10-29) · **Severity:** SEV1 · **Status:** fixed + fully backfilled
**Components:** `gtfs_archive` (Go), Kafka (`raw.vehicle-positions`), Postgres history

## Summary

A Kafka `Not Coordinator For Group` error wedged the archive consumer into a
zombie: the container stayed "healthy" while writing zero lines for 5,720
minutes (4 days). Postgres history stopped in the same minute; Mongo kept
receiving full volume, which is exactly why nothing else noticed. Recovered
in full by restart + backfill (only ~17 s of messages irrecoverable).

## Timeline (UTC)

- **2026-10-26 05:19:33**: `Not Coordinator For Group` error wedges the
  consumer; the same broker failure wipes/recreates the topic (retained data
  begins 2026-10-26T05:19:50Z, `start_off=0` on every partition).
- **10-26 → 10-29**: `lines=0` every minute in `gtfs_archive` logs; archive
  files stop at an unfinalized `2026-10-26/05.ndjson`; `archive-group` has no
  committed offsets and no members; healthcheck stays green. Postgres
  `route_hourly_stats` stops at 05:19; Mongo keeps receiving ~335 K docs/day.
- **2026-10-29**: found during the compactor investigation ("archiver lines
  per minute" is what surfaced it). Restart of `gtfs_archive` resumes
  consuming ~1 K lines/min; the stack restart auto-replays Kafka into Postgres
  for Oct 26–29 (3,311–3,329 rows/day: commit-after-persist saved history);
  the stale `05.ndjson` auto-finalizes to `.gz` (`finalizeStale()`).
- **2026-10-29/30**: raw NDJSON hole backfilled in full: 11,619,605 messages
  re-read by record time [10-26 05:18, 10-30 04:45) into 96 hour files, merged
  with exact-string dedupe on `ingested_at` at the two boundary hours (Oct 26
  h05: 20,946 lines, 0 dupes; Oct 30 h04: 68,084 lines, 1,596 dupes dropped;
  94 files moved). Irrecoverable: ~17 s of messages.

## Evidence

- `docker logs gtfs_archive`: 5,720 consecutive minutes of `lines=0`.
- `archive-group` offsets: no commits, no members: while the container was Up
  and healthcheck-green.
- Kafka topic start offset 0 at 2026-10-26T05:19:50Z (broker-side wipe).
- Postgres: zero new `route_hourly_stats` rows after 05:19 Oct 26 until the
  restart; Mongo `schedule_deviations` kept flowing at full volume.

## Root cause

Two stacked failures: (1) a transient Kafka coordinator error left the
consumer loop wedged instead of reconnecting (the loop kept "running" without
consuming); (2) a monitoring blind spot: the healthcheck measured process
liveness, not **output freshness**, and pino-less app logging hid the wedge.

## Fix

Restart (recovering offsets from the last commit); startup `finalizeStale()`
closed the half-written hour; the commit-after-persist design (write → fsync →
then commit) meant nothing was lost: the backfill re-read the retained
window with exact-string boundary dedupe. INFO logging added to compaction
passes (a successful pass used to log nothing: the same blind spot).

## Alert that would have caught it

**Output-freshness alerting**: "no archive lines for N hours" would have
fired within the first hour. This incident is the reason `HEALTHCHECKS_*`
exist (deployed 2026-11-07): rule 2 (hourly deviation volume) would have
caught the Postgres-side stop, and the daily report now carries
"archiver lines/min" as a wedge detector. Note rule 2 would NOT see this via
Mongo (deviations kept flowing): the archive's own line counter needs its
own dead-man ping; still a recommendation, not yet wired.
