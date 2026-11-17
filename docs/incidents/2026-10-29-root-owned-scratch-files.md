# Root-owned files blocked cleanups

**Dates:** 2026-10-29 to 2026-11-01 · **Severity:** SEV3 · **Status:** fixed
**Components:** sandbox trial outputs, scratch directories

## Summary

One-off container runs as root left root-owned directories behind. A "no
parquet output" symptom turned out to be a permissions artifact (a root-owned
staging directory from sandbox trials), and about 1.5 GB of scratch could not
be deleted by the unprivileged operating user.

## Timeline

- **2026-10-29/30**: compactor output investigation hits permission denials on
  root-owned dirs; cleanup via a root container works.
- **2026-11-01**: scratch cleanup completed during the disk-pressure work (see
  `2026-11-01-disk-pressure.md`).

## Evidence

- `ls` shows root ownership under the archive/scratch trees where the archiver
  (uid 10001) or the deploy user should own files.
- Delete attempts as the deploy user fail with permission denied.

## Root cause

One-off containers (sandbox trials, `docker run` probes) default to root and
create bind-mount files as root, while day-to-day operations run as an
unprivileged user.

## Fix

Delete via a root container (`docker run --rm -v ...:/work --entrypoint sh
alpine -c 'rm -rf ...'`); run one-offs with `--user` matching the target
owner. Ownership is now checked as part of compaction verification.

## Alert that would have caught it

None: this is hygiene, not availability. The daily report's disk section
surfaced the symptom (disk bytes that could not be reclaimed), which is how it
was found.
