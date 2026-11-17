# Compactor DuckDB OOM: zero Parquet files produced

**Date:** 2026-10-29 (fixed 2026-10-29/30) · **Severity:** SEV2 · **Status:** fixed
**Components:** `gtfs_archive_compactor` (DuckDB)

## Summary

Every daily compaction pass died with a DuckDB out-of-memory error at
`mem_limit: 256m`; all 6 eligible days failed, 0 Parquet files ever produced.
Sandbox probes revealed **three** distinct OOM causes; a structural rewrite
fixed it at the original 256 MB.

## Timeline

- **2026-10-29**: deployed compactor failing; every pass OOMs; 0 files.
- **2026-10-29**: sandbox trial at 1200 MB proves the design works
  (Oct 23 day: 2,849,451 rows == 2,849,451 lines).
- **2026-10-29/30**: root causes isolated by probes; hour-by-hour fold fix;
  verified at 256 MB; 32/32 tests; deployed; startup pass folded Oct 20–28
  with exact row fidelity.

## Evidence

- A day ≈ 115 MB gzipped ≈ 1 GB raw text / ~2.8 M lines; DuckDB capped itself
  at 204 MB and OOM'd.
- Three causes at 256 MB: (a) `read_csv` binding a 24-file glob allocates
  per-file reader buffers up front (~183 MB): even a pure `CREATE VIEW`
  OOM'd, `sample_size` didn't help; (b) one shared connection accumulated
  pinned buffers across the day's folds, never evicted; (c) the Parquet
  writer's default row group needed a 43.6 MB raw-column block.
- DuckDB spilling saved none of it (temp-table base storage doesn't spill);
  still OOM at 384 m.
- Post-fix at 256 MB on a full day: exit 0, 2,849,451 rows == 2,849,451 lines,
  24 hour-parquets.

## Root cause

Memory was bounded at execution but not at *bind* time; per-day processing
accumulated buffers in one long-lived connection.

## Fix

Fold **hour-by-hour** with a **fresh connection per hour**, `threads=1`,
capped `ROW_GROUP_SIZE`; cost = decompress twice (seconds). Verify-then-delete
kept: row count == line count before raw deletion after the 7-day grace.

## Alert that would have caught it

Daily health report "last compactor pass + rows==lines" (present since the
Oct 30 rework) and the `--once` flag making passes cron-visible with non-zero
exit. Before that, compaction passes logged nothing at all on success: the
same silence that hid the archive wedge.
