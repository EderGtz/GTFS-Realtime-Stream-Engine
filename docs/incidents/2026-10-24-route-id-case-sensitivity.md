# "Orange" route-ID case sensitivity

**Date:** 2026-10-24 (found) · **Severity:** SEV3 · **Status:** fixed (2026-11-24)
**Components:** `gtfs_api` (`routePerformance.ts`, `routeHistory.ts`, `routeCatalog.ts`), frontend search

## Summary

Searching `orange` returns 0 results and an empty history; `Orange` returns 10
vehicles, avg deviation 110 s, on-time 70%, full 7-day history. MBTA route IDs
are stored exactly as published and both endpoints match `route_id` exactly.

## Timeline

- **2026-10-24**: found while investigating the empty-history scare.
- **2026-10-24**: fix recommended; no implementation confirmed since.
- **2026-11-24**: implemented at the API edge (`routeCatalog.ts`), closed at
  project shutdown.

## Evidence

- `orange` → "vehicles tracked: 0"; `Orange` → 10 vehicles with history.
- `routePerformance.ts` / `routeHistory.ts` do exact `route_id` matching on
  indexed columns.

## Root cause

Case-sensitive exact matching against canonical MBTA IDs (`Orange`, `Green-B`,
`CR-Providence`). Naive `capitalize()` is not a fix (`green-b` vs `Green-B`,
commuter-rail prefixes).

## Fix (implemented 2026-11-24)

API-layer canonicalization, as recommended: `routeCatalog.ts` resolves any
casing to the canonical ID through a cached `lowercase -> canonical` map built
from the distinct `route_id`s the stack has data for (Mongo `schedule_deviations`
+ `bunching_events`, Postgres `route_hourly_stats`; 5-minute TTL), then the
existing exact-match queries run unchanged — no `lower()` on the hot path.
Both `/v1/routes/:id/performance` and `/v1/routes/:id/history` resolve through
it and echo the canonical ID; the map shows a "showing results for Orange"
hint when the searched casing differed.

Unknown IDs now return 404 with a hint ("try a route ID like 1, 28, Red or
Green-D — route IDs, not vehicle IDs") instead of a misleadingly empty 200.
That covers `sl1` from the verification attempt: `SL1` is not a `route_id` in
the GTFS data at all (the Silver Line's IDs are numeric, `741`–`749`), so no
casing of `sl1` can match. No alias table was added — guessing `SL1`→`741`
mappings is worse than an explanatory 404, and the case bug proper
(`orange`→`Orange`, `green-b`→`Green-B`, `34e`→`34E`) is fixed.

## Alert that would have caught it

No alert class covers this: it is a product-level lookup defect, invisible to
volume/freshness monitors. The right detector is a per-endpoint "zero-result
rate for known-good route IDs" smoke probe (search `1`, `Red`, `Orange` daily).
