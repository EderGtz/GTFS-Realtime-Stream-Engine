# Raw pruning stalled: verify-then-delete hit PermissionError

**Dates:** 2026-11-08 to 2026-11-13 (found and fixed 2026-11-13) · **Severity:** SEV2 (disk grew to 90%) · **Status:** fixed
**Components:** `gtfs_archive_compactor`, `docker-compose.yml` hardening

## Summary

The 2026-11-08 container hardening (`cap_drop: [ALL]`) silently broke raw
archive pruning: the compactor runs as root and, without `CAP_DAC_OVERRIDE`,
could no longer unlink raw files owned by the archiver's uid (10001). Every
daily pass failed with `PermissionError`, raw days piled up at ~115 MB/day,
and the disk climbed from about 80% to 90% in five days.

## Timeline

- **2026-11-08**: the hardening release deploys (`cap_drop: [ALL]`,
  `read_only: true`, tmpfs on the app containers).
- **2026-11-09 onward**: each 03:00 UTC pass logs
  `ERROR:archive-compactor:verify-then-delete failed` with
  `PermissionError: [Errno 13] Permission denied` on raw `.ndjson.gz` files,
  ending in `WARNING: pass complete with N failing day(s)`. Compaction itself
  keeps working (parquet output was fine), so the failure mode is quiet.
- **2026-11-13 17:50**: disk check finds 90% used / 3.8 GB free; the error
  pattern in the compactor log identifies the regression. Fix applied the same
  hour: the compactor now runs as uid 10001 (the archiver's uid), the archive
  tree is chowned to match, and the stalled days are deleted on the next
  pass (6 days, 144 files, verified). Disk recovered to 80% (7.5 GB free)
  after a build-cache prune.

## Evidence

- Compactor log, daily from Nov 9: `PermissionError: [Errno 13] Permission
  denied: '/data/archive/2026-11-02/00.ndjson.gz'` in `delete_raw_day()`,
  5 failing days per pass.
- Raw archive held days back to 2026-10-30 (~1.6 GB) where the 7-day grace
  policy should have kept only about one week (~0.9 GB).
- File ownership: raw files `10001:10001` (written by `gtfs_archive`), the
  compactor `User=` (root). Deleting a file needs write permission on the
  containing directory; root without `CAP_DAC_OVERRIDE` only has root's own
  permission bits, and the archiver's directories are mode 755 owned by 10001.

## Root cause

The hardening removed root's `CAP_DAC_OVERRIDE` but the compactor still ran as
root, relying on exactly that capability to delete files it does not own.
Cap-dropping and file-ownership semantics interact, and nothing exercised the
delete path against archiver-owned files after the change.

## Fix

`docker-compose.yml` (left uncommitted for review): the compactor now runs as
`user: "10001:10001"`, the same uid as the archive consumer, with the archive
tree chowned to match. No capability is needed: owner permissions cover both
raw deletion and parquet writes. Verified live: a full pass deletes the six
stalled days cleanly, and uid 10001 can create and remove files under
`parquet/`. `cap_drop: [ALL]` and `read_only: true` stay in place.

## Alert that would have caught it

The daily ops report's compactor wedge detector ("last compactor pass +
rows==lines") covers compaction output but not the deletion step. This needs
one more line: "raw days kept vs policy (7)". A disk-projection line
("at +N MB/day, K weeks of headroom") would also have surfaced the climb
before it reached 90%.
