# External review hardening findings (rate limit, CDN, extract, keys, USER)

**Date:** 2026-10-26 (found) · **Severity:** SEV3 · **Status:** mostly fixed
**Components:** `gtfs_api`, `gtfs_analytics` (refresh), `gtfs_postgres` schema, Go image

## Summary

An external code review surfaced five defects that never caused an outage but
were real gaps; four have since been fixed. The review's SEV-level findings
(service-date filter, bunching false positives, Mongo TTL, the bunching
consecutiveness bug, and the DST bug) each have their own incident file.

## Findings, status, fixes

| Finding | Risk | Fix | Status |
|---|---|---|---|
| Rate limit 100 req/15 min per IP | Shared/CGNAT IPs throttle each other | 600/15 min with CGNAT rationale (deployed 2026-11-04) | fixed |
| Leaflet/Chart.js from unpkg CDN, no SRI | Supply chain | Bundled via esbuild, CDN dropped (0e50eb0, 2026-11-08) | fixed |
| `extractall` straight into the live GTFS dir | A corrupt bundle wipes live data | Staging + validation + atomic swap (724a708, 2026-11-02) | fixed |
| `PRIMARY KEY (route_id, hour)` without `agency_id` | Blocks multi-agency use | Deferred: schema change needs a migration | **open** |
| `USER` only in the Go image | Containers run as root | `cap_drop: [ALL]`, `read_only: true`, tmpfs (b98c4b6, 2026-11-08) | fixed |

One review claim was dead on arrival: a `print("refres.py called")` debug line
did not exist in the checkout.

## Alert that would have caught it

None of these are alertable: they are design gaps found by code review. The
process answer is periodic review of the security posture.

## Evidence

- Rate limit headers pre/post: `RateLimit: 100;w=900` then `RateLimit:
  600;w=900` (verified live 2026-11-04).
- Compose and Dockerfile diffs add `cap_drop: [ALL]`, `read_only: true`,
  `tmpfs: /tmp` for ingestion, api, archive and compactor (verified live
  2026-11-08: all containers Up/healthy under the hardened flags).
