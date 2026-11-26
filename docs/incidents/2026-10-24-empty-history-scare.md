# "All history lost" scare: volumes intact, search takes route IDs

**Date:** 2026-10-24 · **Severity:** none (no data loss; UX bug) · **Status:** fixed (2026-11-24)
**Components:** frontend search UX, `gtfs_api`

## Summary

After an apt upgrade and a Docker restart the map showed an empty state and
the report came in as possible total history loss. It was not: all volumes
were on disk and intact, and the search bar takes route IDs, not vehicle IDs.

## Timeline

- **2026-10-24**: apt upgrade + Docker restart; searching a vehicle ID returns
  "vehicles tracked: 0" and an empty history.
- **2026-10-24**: investigation shows all volumes intact. In the same session
  the "Orange" case-sensitivity bug surfaces (see
  `2026-10-24-route-id-case-sensitivity.md`).

## Evidence

- Mongo/Postgres/Kafka volumes and the NDJSON archive on disk, untouched by
  the restart.
- Searching a vehicle ID returns 0 results; searching route IDs (`1`, `28`,
  `Red`, `Green-D`) returns full history. The search field matches `route_id`
  only.
- Container-reconnect ordering produces transient empty states in the first
  minutes after any restart.

## Root cause

UX: an empty state that reads "wait until information gathers up" when the
real answer is "no route with that ID found". The only genuine loss vector on
restart is analytics' in-memory hourly accumulator (at most 1 h of partial
route stats before the hourly Postgres flush), which is by design.

## Fix

Implemented 2026-11-24 (copy, as recommended, plus an API contract change):

- `/v1/routes/:id/...` now returns **404 with a hint** for unknown route IDs
  ("No route with that ID found. The search takes route IDs — try 1, 28, Red
  or Green-D — not vehicle IDs."), so searching a vehicle ID answers the real
  question instead of rendering an empty state that reads like data loss.
- The empty-history state (route known, no rows in range) says so plainly:
  "No hourly history for this range yet — data accumulates hour by hour while
  the pipeline runs."
- The search help panel states up front that the search takes route IDs, not
  vehicle IDs.

A side effect of the same change: case-insensitive route lookup
(`2026-10-24-route-id-case-sensitivity.md`), which produced several of the
"empty" reports behind this scare.

## Alert that would have caught it

None needed, since nothing broke. The class of confusion is mitigated by
`/v1/pipeline/status` (last message age, consumer lag, last static reload),
which answers "is the pipeline actually stale?" without guessing.
