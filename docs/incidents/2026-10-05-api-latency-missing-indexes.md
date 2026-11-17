# API and search latency around 10 s: missing read indexes

**Date:** 2026-10-05 (fixed about 2026-10-09) · **Severity:** SEV2 · **Status:** fixed
**Components:** MongoDB `schedule_deviations`, `gtfs_api` (routePerformance, routeHistory)

## Summary

Map search took about 10 s and `/v1/status/live` about 4 s for small payloads.
The cause was unindexed reads doing a full collection scan over 2.7 M
documents; one compound-index change brought searches to 55 ms.

## Timeline

- **2026-10-05**: latency analysis; a Mongo explain shows a COLLSCAN;
  `docs/api-latency-analysis.md` written with the fix.
- **2026-10-09**: indexes applied; verified at 55 ms search and 15 ms
  `/v1/status/live`.

## Evidence

- Mongo explain on a search query: COLLSCAN, 2,707,325 docs examined to return
  9 results, 7.6 s.
- Only `_id`, the upsert idempotency key `(vehicle_id, trip_id,
  stop_sequence, kind)` and a 2dsphere index existed: the schema was indexed
  for writes, not for the read pattern.
- WiredTiger cache `--wiredTigerCacheSizeGB 0.25` vs an 865 MB collection
  meant disk reads (2.9 s cache-cold vs 6.8 s variance).
- The map polls `/v1/status/live` every 30 s, running the same scans: the load
  multiplied itself.
- Post-fix: search 55 ms (later 41 ms), `/v1/status/live` 7 to 19 ms.

## Root cause

Write-side indexes only. Every read path degenerated to a full scan as the
collection grew, and the 72 h retention kept refilling it.

## Fix

Compound read indexes `dev_route_time` (route_id, actual_at), `dev_time`,
`bunch_route_time` (route_id, end_time), `bunch_time`; Mongo cache raised to
0.75 GB.

## Alert that would have caught it

The daily ops report's API latency baseline (under 100 ms). A synthetic probe
(`/v1/routes/1/performance` timed hourly) is the standing recommendation;
today `/v1/pipeline/status` covers freshness but not latency.
