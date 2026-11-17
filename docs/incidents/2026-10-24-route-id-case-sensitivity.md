# "Orange" route-ID case sensitivity

**Date:** 2026-10-24 (found) · **Severity:** SEV3 · **Status:** **OPEN**
**Components:** `gtfs_api` (`routePerformance.ts`, `routeHistory.ts`), frontend search

## Summary

Searching `orange` returns 0 results and an empty history; `Orange` returns 10
vehicles, avg deviation 110 s, on-time 70%, full 7-day history. MBTA route IDs
are stored exactly as published and both endpoints match `route_id` exactly.

## Timeline

- **2026-10-24**: found while investigating the empty-history scare.
- **2026-10-24**: fix recommended; no implementation confirmed since.

## Evidence

- `orange` → "vehicles tracked: 0"; `Orange` → 10 vehicles with history.
- `routePerformance.ts` / `routeHistory.ts` do exact `route_id` matching on
  indexed columns.

## Root cause

Case-sensitive exact matching against canonical MBTA IDs (`Orange`, `Green-B`,
`CR-Providence`). Naive `capitalize()` is not a fix (`green-b` vs `Green-B`,
commuter-rail prefixes).

## Fix (recommended, not implemented)

API-layer canonicalization: one case-insensitive lookup resolving input to the
canonical ID (indexed `lower(route_id)` mapping or a small alias table), then
the existing exact-match queries. Frontend "showing results for Orange" hint.
Avoid `lower()` on hot query paths.

## Alert that would have caught it

No alert class covers this: it is a product-level lookup defect, invisible to
volume/freshness monitors. The right detector is a per-endpoint "zero-result
rate for known-good route IDs" smoke probe (search `1`, `Red`, `Orange` daily).
