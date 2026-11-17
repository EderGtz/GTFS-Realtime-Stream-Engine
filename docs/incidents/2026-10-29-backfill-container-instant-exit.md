# Backfill container exited instantly: wrong interpreter

**Date:** 2026-10-29 · **Severity:** SEV3 (tooling) · **Status:** fixed
**Components:** backfill one-off container (analytics image)

## Summary

The Kafka backfill consumer container exited immediately without writing
anything: the image's system `python3` has none of the venv dependencies.

## Timeline

- **2026-10-29**: backfill launched for the archive-hole recovery; container
  exits instantly, no output.
- **2026-10-29**: relaunched with `/app/.venv/bin/python`; runs fine
  (confluent_kafka 2.15.0 lives in the venv).

## Evidence

- Container exit 0/1 with an import error path and no files written.
- `docker run ... python3 -c 'import confluent_kafka'` fails; same with
  `/app/.venv/bin/python` succeeds.

## Root cause

The analytics image has two interpreters; only `/app/.venv/bin/python` carries
the app dependencies. Scripts assumed "python3 == app python".

## Fix

Run one-off tooling in that image with the venv interpreter explicitly.
Recorded as a pitfall for future tooling.

## Alert that would have caught it

None: one-shot tooling. The safeguard is procedural: probe the actual runtime
inside an image (`printenv`, `which python`, import check) before scripting
against it.
