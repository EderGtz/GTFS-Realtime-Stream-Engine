# MongoDB grew without bound: no TTL on schedule_deviations

**Date:** found 2026-10-26, fixed 2026-11-01 · **Severity:** SEV2 · **Status:** fixed
**Components:** MongoDB (`schedule_deviations`, `bunching_events`), `writer.py`

## Summary

`schedule_deviations` had no TTL: 7.5 M docs / 577 MB on Oct 26 grew to 9.2 M
docs / 699 MB + 682 MB of indexes by Nov 1 (~30 MB/day) and would never stop.
Fixed with 14-day TTL indexes.

## Timeline

- **2026-10-26**: external review flags it (finding A2).
- **2026-11-01**: TTL applied in the live DB and in `writer.py
  _ensure_indexes()`: `dev_ttl` on `actual_at`, `bunch_ttl` on `end_time`,
  14 days. ~5.5 M docs queued for cleanup (~800 MB).
- **2026-11-01 → 11-03**: 9.18 M → 8.5 M docs, heading to ~3.7 M steady.

## Evidence

- `db.schedule_deviations.stats()`: 9.2 M docs, 699 MB data + 682 MB indexes
  on 2026-11-01 (7.5 M / 577 MB on 10-26): ~30 MB/day, monotonic.
- API Mongo queries use a 3-minute window; route history reads Postgres 
  nothing needs more than 14 days in Mongo.

## Root cause

Indexes were created for the read pattern but no lifecycle policy existed;
Mongo collections don't shrink on their own.

## Fix

TTL indexes (14 days) in both the live DB and `_ensure_indexes()` so every
deploy recreates them. Safe because no query path reads older documents.

## Alert that would have caught it

Daily health report disk/DB-size baselines. The standing recommendation is a
collection-size line per report (docs + MB per collection vs 7-day trend) 
30 MB/day is invisible in a "disk 70%" verdict until weeks pass.