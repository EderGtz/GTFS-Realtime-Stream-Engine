# Kafka topic data written to the container layer, not the volume

**Date:** 2026-10-25 (found; latent since 2026-09-25) · **Severity:** SEV1 (latent wipe hazard) · **Status:** fixed
**Components:** `gtfs_kafka`, `docker-compose.yml`

## Summary

All Kafka topic data was going to `/tmp/kraft-combined-logs` inside the
container layer while the mounted `kafka_data` volume sat empty: any container
recreate would have silently wiped every topic and both consumer groups'
offsets. A recreate during this investigation did exactly that (predicted; both
groups rejoined cleanly).

## Timeline

- **2026-09-25 to 2026-10-25**: data accumulates in the container layer
  (5.79 GB by discovery), volume empty (4 KB).
- **2026-10-25**: found while investigating the healthcheck CPU burn.
- **2026-10-25 23:11**: recreate (for the healthcheck fix) wipes the
  in-container data; topics + offsets reset; both groups rejoin at zero lag.
- **2026-10-25 (late)**: `KAFKA_LOG_DIRS: /var/lib/kafka/data` applied, Kafka
  recreated, `gtfs_ingestion` restarted so `setupTopics` re-creates
  `raw.vehicle-positions` (`KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`).

## Evidence

- `docker stats`/layer inspection: `gtfs_kafka` container layer 5.79 GB;
  `kafka_data` volume 4 KB.
- After fix: volume holds data (828 KB and growing), container layer 291 KB;
  `__consumer_offsets` present in the volume.

## Root cause

On KRaft images the broker's `log.dirs` defaults to `/tmp/kraft-combined-logs`;
the compose file mounted `/var/lib/kafka/data` but nothing pointed the broker
at it. Persistence only *looked* real.

## Fix

`KAFKA_LOG_DIRS: /var/lib/kafka/data` (the apache/kafka image maps `KAFKA_*`
env vars to broker config). Ingestion restart after any topic wipe because
auto-create is off and `producer.setupTopics()` owns topic creation.

## Alert that would have caught it

A "Kafka data volume empty / container layer growing" disk check: today's
daily report covers disk % and `docker system df` implicitly via baselines.
The direct detector is a config assertion: `kafka-log-dirs.sh` output must
point inside the mounted volume (one-line probe for the daily report).
