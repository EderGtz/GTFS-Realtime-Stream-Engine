# Bunching false positives at terminals + exact-15s consecutiveness

**Date:** found 2026-10-26, fixed 2026-11-04 · **Severity:** SEV2 (bogus published numbers) · **Status:** fixed
**Components:** `analytics-engine` (`metrics/bunching.py`)

## Summary

Bunching detection counted buses queued at a terminal as "bunched" (pure
euclidean proximity) and demanded exact 15-second bucket consecutiveness to
count a sustained event: inflating bunching counts at depots and missing real
events on jittery data. (External review findings A1 + M3.)

## Timeline

- **2026-10-26**: external review: A1 (terminal false positives), M3
  (exact-15s consecutiveness).
- **2026-11-02 16:15**: fix committed (04b1229); deployed **2026-11-04** with
  regression tests (46 lines in `test_bunching.py`).

## Evidence

- `find_close_pairs()` matched purely on route + direction + 15s time bucket
  euclidean proximity: two buses parked at a terminal from the same route
  matched every bucket → long "bunching events" that were just a layover.
- Real bunched pairs separated by telemetry jitter (14 s + 17 s apart) fell
  outside consecutive exact buckets and never registered as sustained.

## Root cause

No domain awareness in the proximity metric: terminals/layovers look exactly
like bunching in euclidean space, and the consecutiveness test assumed
perfectly aligned 15s buckets.

## Fix (deployed 2026-11-04)

250 m terminal exclusion (fail-open when terminal data is missing);
separated-pair break detection for jitter; one-bucket consecutive tolerance
(the M3 fix).

## Alert that would have caught it

No volume/freshness alert catches a *wrong number*: this is value-quality,
not availability. Recommended: a bunching sanity probe (bunching events/hour
vs 7-day baseline per route; a depot-sited route showing constant bunching is
the signature). Data-quality alerting today covers deviation volume
(rule 2) and match ratio (rule 1), not bunching.