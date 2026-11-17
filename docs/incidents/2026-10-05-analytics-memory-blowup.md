# Analytics engine RAM blowup: 1.5 GB RSS on a 4 GB host

**Date:** 2026-10-05 (fixed through October) · **Severity:** SEV2 · **Status:** fixed
**Components:** `analytics-engine` (`gtfs_static/loader.py`)

## Summary

`gtfs_analytics` held 1.48 GiB RSS (about 40% of server RAM) at 0.5% CPU,
forcing swap and squeezing Mongo's cache. The 141 MB `stop_times.txt` ballooned
past 1 GB as a Python dict of per-row dataclass objects.

## Timeline

- **2026-10-05**: RAM analysis; `docs/analytics-memory-analysis.md` written
  with the fix.
- **October**: implemented: active-service filtering of trips (that feature's
  own bug is covered in `2026-11-01-service-date-and-dst.md`), compact
  structures, `mem_limit: 1g`.
- **2026-11-04**: `mem_limit` raised to `2g` with measured rationale.

## Evidence

- `gtfs_static/loader.py` loads `stop_times.txt` (3,155,221 rows / 141 MB) and
  `trips.txt` (122 K rows) with pandas, then expands into
  `stop_times_lookup`: a dict of 3.15 M tuple-keyed dataclass objects.
  Per-object overhead turns 141 MB of CSV into over 1 GB of RSS.
- Secondary: `refresh.py` reload doubles memory transiently.
- Verified not leaking: `consumer.py` dedup trackers purge correctly.

## Root cause

Python per-object memory overhead over a row-expanded lookup. The design
traded RAM for lookup speed and lost on a 4 GB host.

## Fix

Filter trips to active `service_ids` via `calendar.txt`/`calendar_dates.txt`
(with a +/- 1 day margin), compact structures
(`@dataclass(frozen=True, slots=True)`, pre-parsed integer seconds), and a
container `mem_limit`. Result: 536 MB down to 317 MB steady (baseline today
300 to 600 MB). Explicitly rejected at the time: a Rust/Go rewrite (the job is
I/O-bound) and polars (a conditional 20-40% win only if joins are
restructured).

## Alert that would have caught it

The daily ops report's RAM/swap baselines (analytics 300 to 600 MB, swap under
400 MB) plus `dmesg | grep -i oom` checks. The host had OOM pressure before
the 2 GB swap was added.
