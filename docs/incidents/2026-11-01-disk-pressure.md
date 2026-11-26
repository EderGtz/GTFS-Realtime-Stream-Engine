# Disk pressure: 84% on a 38 GB disk (two episodes)

**Dates:** 2026-10-25 (79% → 63%), 2026-11-01 (84% → 70%) · **Severity:** SEV2 · **Status:** fixed (parquet retention landed 2026-11-24)
**Components:** Docker (build cache, volumes), Kafka segments, Mongo, parquet archive

## Summary

Disk climbed into the 80%+ twice in a week. One-time bloat (build cache,
orphaned volumes, retired images) plus four steady accumulators. Reclaimed to
~70%; the parquet archive grew ~100 MB/day with **no retention policy** until
one landed on 2026-11-24 (see Fix).

## Timeline

- **2026-10-25**: 79% → 63% after `docker system prune` / `builder prune`
  (6.36 GB build cache).
- **2026-10-30 → 11-04**: daily reports track 77% → 84%.
- **2026-11-01**: 84% → 70%: build cache 4.83 GB, 9 orphaned anonymous
  volumes, retired `kafkabat-ui` image 637 MB, agent scratch leftovers.

## Evidence (the four accumulators)

1. **Docker build cache** 4.8–6.4 GB from repeated `--build` deploys.
2. **Kafka segments** 6.1 GB: 1 GB segment rolls defeated the 72 h retention
   (5–9 days effective) → `KAFKA_LOG_SEGMENT_BYTES=256MB` (2026-11-01,
   volume 6.1 GB → ~2 GB over two days).
3. **Mongo unbounded growth**: see `2026-11-01-mongo-unbounded-growth.md`.
4. **Parquet** ~100 MB/day (24 zstd files/day): grows forever, 1.2 GB by
   Nov 3. ~3–4 weeks of headroom per Nov 4 reading.
- False alarm recorded and corrected: raw NDJSON pruning *was* working (7-day
  grace from compaction, deletion began ~Nov 5–6).

## Root cause

No single runaway: four bounded-but-unbounded-by-policy producers on a 38 GB
disk, plus repeat-build cache that only `docker builder prune` reclaims.

## Fix

Prunes applied; Kafka segment bytes 256 MB; Mongo TTL; agent scratch cleaned.
**Closed 2026-11-24:** parquet retention implemented — the compactor's daily
pass now prunes `parquet/date=YYYY-MM-DD` days once they turn
`PARQUET_KEEP_DAYS` old (default 30, `0` = keep forever; ~90 MB/day measured,
so the tier plateaus at ~2.7 GB instead of growing forever). A retention
failure fails the pass rather than logging past it. Monthly offload to R2/B2
remains the recommendation for keeping pruned months: retention deletes, it
does not back up.

## Alert that would have caught it

Daily health report disk % with baselines (58–66% green): it did track the
climb. What's missing: a *projection* line ("at +100 MB/day, 3.5 weeks of
headroom") so the trend is actionable before the 80% alarm.