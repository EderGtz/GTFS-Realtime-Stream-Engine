# gtfs_analytics crash-loop on deploy: EXDEV on overlayfs

**Date:** 2026-11-04 (deploy 07:15) · **Severity:** SEV1 (deploy outage) · **Status:** fixed
**Components:** `analytics-engine` (`gtfs_static/refresh.py`), Docker overlayfs

## Summary

Deploying the 2026-11-04 release crash-looped `gtfs_analytics`: the new GTFS
refresh used `Path.rename()` for its atomic swap, which overlayfs refuses for
a directory from the image's lower layer (`EXDEV`). A first install could
never complete. Fixed the same day with `shutil.move` plus crash recovery, and
verified live.

## Timeline (UTC)

- **2026-11-04 07:15**: the release is deployed with `--build` (it includes
  staging + atomic swap for GTFS refresh, 724a708).
- **07:1x**: `gtfs_analytics` crash-loops; the GTFS static dir is missing
  files.
- **same day**: root cause found (the swap rename); `refresh.py` fixed and
  left uncommitted per the project's review workflow; 58/58 tests; the
  container recovers with "GTFS static data updated successfully" and
  deviations flowing again.

## Evidence

- Container restart loop; partial `/app/data/MBTA_GTFS` after failed swaps.
- `Path.rename()` across the overlayfs lower-to-upper boundary raises `EXDEV`
  (cross-device link). The image bakes an empty `/app/data/MBTA_GTFS` in the
  lower layer (no volume), so the bundle always downloads at startup and the
  first swap always crosses that boundary.
- Invisible to review/CI: the old code extracted in place (it never renamed),
  and tests use tmp dirs where rename works.

## Root cause

Atomic-rename semantics do not hold on overlayfs for lower-layer directories.
The staging design was correct, but its atomic-swap primitive was not valid on
the deployment filesystem.

## Fix

`refresh.py` now uses `shutil.move` (which falls back to copy+delete on
`EXDEV`) plus crash recovery that restores the parked `.old` bundle if a crash
leaves a half-copied target. Committed upstream 2026-11-08 (5a75bc4). Later
deploys (2026-11-07, 2026-11-08) verified clean.

## Alert that would have caught it

The data-quality check's silence/dead-man mode (analytics stops pinging within
one 60 s window) and any deploy-verification step ("post-deploy: all
containers healthy, `/v1/pipeline/status` fresh"). The lasting lesson: an
"atomic" file operation must be tested against the production filesystem type,
not just tmp dirs.
