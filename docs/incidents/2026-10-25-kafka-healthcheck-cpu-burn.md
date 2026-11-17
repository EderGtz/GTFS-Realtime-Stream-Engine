# Kafka healthcheck burned one full CPU core

**Date:** 2026-10-25 (found) · **Severity:** SEV2 · **Status:** fixed
**Components:** `docker-compose.yml` (kafka healthcheck)

## Summary

Kafka showed sustained 96–99% CPU (~1 core) while the broker itself was idle.
The compose healthcheck booted a whole JVM every 10 seconds: 8,640 JVM
launches a day.

## Timeline

- **2026-10-20**: Kafka CPU 2.7% (baseline).
- **2026-10-25**: 96–99% sustained across samples; load average fine.
- **2026-10-25**: root cause found (a 2-second-old Java process caught at
  122% CPU), interval raised to 60 s.

## Evidence

- `kafka-broker-api-versions.sh` per probe: ~1.5–2 s at 100%+ CPU, ~96 MB
  RAM, every 10 s.
- Broker's own threads idle–9%; GC healthy → the container stats were mostly
  healthcheck bursts.
- Post-fix: interval 60 s, CPU back to normal.

## Root cause

A JVM CLI used as a frequent healthcheck is its own workload; every probe
forked a full Kafka client JVM against a 2 vCPU box.

## Fix

Healthcheck `interval: 60s` with a comment explaining the JVM-per-probe cost
so it isn't "fixed" back. Optional replacement noted in code: plain TCP probe
`bash -c '</dev/tcp/127.0.0.1/9092'`.

## Alert that would have caught it

Daily health report CPU/load baselines (load < 1.5; the box idles under that).
Container CPU vs baseline belongs in the report's container section.
