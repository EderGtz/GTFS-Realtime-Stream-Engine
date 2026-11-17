# Silent analytics data loss: service-date filter bug and DST anchoring bug

**Dates:** 2026-10-13 to 2026-11-02 (intermittent; worst day 2026-11-01)
**Severity:** SEV1: silent data loss in published stats, no crash, no alert
**Components:** `analytics-engine` (`gtfs_static/loader.py`, `metrics/schedule_deviation.py`, `consumer.py`)
**Status:** fixed (both fixes committed 2026-11-02, deployed 2026-11-04)

## Summary

Two independent bugs in the analytics engine silently discarded schedule
deviations while the raw telemetry stream stayed perfectly healthy. Bug A
(active-service filter) struck intermittently from Oct 13 whenever the GTFS
static bundle stopped republishing, draining a service day down to roughly 10%
of its routes. Bug B (DST anchoring) struck the 25-hour day of Nov 1: from the
fall-back instant every scheduled time resolved one hour early, the 30-minute
acceptance gate rejected the results, and the rest of the service day produced
near-zero output with poisoned survivors (on-time 0-3%). On Nov 1 both bugs
were live at once. Nothing crashed; `route_hourly_stats` simply under-reported
roughly 59 K vehicle-hour observations across six damaged days.

## Timeline (UTC)

- **2026-09-05**: `resolve_scheduled_datetime()` ships (8d441f8) with
  `midnight + timedelta` anchoring.
- **2026-10-06**: active-service filtering ships (60a48e9): window
  "UTC-today +/- 1 day", built only inside `load()`, in other words only when
  the GTFS bundle changes.
- **2026-10-13 06:00**: first damage. The new service day's trips stop
  matching (see Evidence for the 02:00 ET rollover signature). Oct 13 keeps
  about 15 routes/hour; Oct 14 keeps 15 routes all day (-93% vehicle-hours).
- **2026-10-14 evening (ET)**: a fresh bundle arrives, the filter rebuilds,
  damage ends.
- **2026-10-19 06:00**: second strike; partial self-heal at 09:00 UTC
  (-72% day).
- **2026-10-20**: the raw NDJSON archive comes online, giving the evidence
  source for "raw kept flowing".
- **2026-10-24 06:00 to 22:00**: third strike: 14 consecutive hours with zero
  rows in `route_hourly_stats` against 1.99 M raw messages that day (-64%).
- **2026-10-26**: an external code review flags the filter design (finding
  C1); live SQL confirms the damaged days (Oct 13-14, 19 at ~30% volume, 24).
- **2026-11-01 06:00 (02:00 EDT)**: clocks fall back. Bug B joins bug A:
  deviation output collapses and the few surviving rows are garbage (on-time
  0-3%). -74% vehicle-hours vs the previous Sunday despite identical raw
  volume (1,675,977 vs 1,671,270 messages).
- **2026-11-02**: the daily ops report notices a deviation lull (about 25 min
  of stale Mongo freshness plus low volume) and logs it as a transient blip.
- **2026-11-02 ~21:00**: volume recovers abruptly in one hour (213 to 850
  vehicle-count): a new bundle triggered a filter rebuild, which was the old
  code's only recovery path. No deploy happened at this time.
- **2026-11-02**: fixes committed upstream: 724a708 (agency-timezone service
  date plus daily staleness reload), cbda73d (noon-minus-12h anchoring),
  b3d2720 and 04b1229 (regression tests).
- **2026-11-04 07:15**: both fixes deployed to production.
- **2026-11-07**: data-quality alerting deployed (`HEALTHCHECKS_*` env vars,
  `/v1/pipeline/status`).
- **2026-11-08**: the rule-1 coverage-check bug is fixed (5a75bc4), so the
  alert that would have caught bug B becomes actually able to fire.

## Evidence

### Raw archive counts vs `route_hourly_stats` (daily)

Raw counts are NDJSON line counts (Oct 30 to Nov 8) or verified parquet row
counts (Oct 20 to 29; compaction guarantees rows == lines). `Sveh` is
`sum(vehicle_count)` per day. Baseline is neighboring healthy days of the
same weekday.

| Day | DOW | Raw msgs | Stats rows | Routes | Sveh | vs baseline | Bug |
|---|---|---|---|---|---|---|---|
| 10-13 | Tue | n/a (archive starts 10-20) | 901 | 138 | 3,156 | -79% (~15 K) | A |
| 10-14 | Wed | n/a | 306 | **15** | 1,016 | -93% | A |
| 10-19 | Mon | n/a | 1,324 | 144 | 4,255 | -72% | A |
| 10-20 | Tue | 2,671,289 | 3,185 | 180 | 14,457 | normal | none |
| 10-23 | Fri | 2,849,451 | 3,315 | 180 | 15,108 | normal | none |
| 10-24 | Sat | **1,987,285** | **1,002** | 160 | **3,621** | -64% (~10 K) | A (14 h with zero rows) |
| 10-25 | Sun | 1,671,270 | 2,496 | 142 | 8,925 | normal Sunday | none |
| 10-27 | Tue | 2,903,691 | 3,327 | 180 | 15,186 | normal | none |
| 10-31 | Sat | 2,068,911 | 2,802 | 162 | 9,743 | normal Saturday | none |
| **11-01** | **Sun** | **1,675,977** | **1,042** | 133 | **2,273** | **-74%** vs 10-25 | **A + B** |
| 11-02 | Mon | 2,758,501 | 1,451 | 176 | 5,182 | -65% | A (until ~21:00) |
| 11-03 | Tue | 2,868,785 | 3,327 | 180 | 15,135 | normal | fixed |

The key comparison: Nov 1 carried a completely normal Sunday message volume
(1.676 M vs Oct 25's 1.671 M, +0.3%) while the stats kept 25% of the previous
Sunday's vehicle-hours. The data was delivered; the analytics threw it away.

### Hourly shape of Nov 1 (UTC): the two signatures

Raw is messages archived that hour; Oct-25 Sveh is the same hour of the
previous Sunday.

| Hour | Raw Nov 1 | Sveh Oct 25 | Sveh Nov 1 | On-time Nov 1 |
|---|---|---|---|---|
| 00 | 96,009 | 505 | 460 | 33% |
| 01 | 88,886 | 472 | 420 | 37% |
| 02 | 79,813 | 418 | 380 | 44% |
| 03 | 72,253 | 352 | 300 | 46% |
| 04 | 65,980 | 311 | 268 | 50% |
| 05 | 36,180 | 208 | 179 | 49% |
| **06** | 11,352 | 47 | **18** | 37% (fall-back instant, 02:00 EDT) |
| 07 | 8,792 | 4 | 1 | n/a (single surviving row) |
| 08 | 7,235 | 38 | 2 | 0% |
| 09 | 10,649 | 192 | 13 | 13% |
| 10 | 31,065 | 306 | 32 | 6% |
| 11-23 | 64 K to 98 K | 377 to 518 | 5 to 32 | **0-3%** |

Hours 00-05 (Saturday-evening ET, pre-transition) are normal. The collapse
begins exactly at the fall-back instant and lasts the rest of the service day,
with survivor quality poisoned (on-time 0-3%, average deviation 400 to
1,450 s).

### Bug discrimination (same low volume, different values)

| Day | Bugs live | Sveh vs baseline | Survivor avg dev | Survivor on-time |
|---|---|---|---|---|
| Oct 13-14 | A only | -79% / -93% | 230 to 350 s | 45 to 68% |
| Nov 1 after 06:00 | A + B | -93% or worse per hour | 400 to 1,450 s | 0 to 3% |
| Nov 2 06:00 to 20:00 | A only (DST day ended 05:00) | ~-70% | 180 to 470 s | 44 to 55% |

Bug A removes trips but computes honest numbers for what survives. Bug B
poisons the numbers themselves. Nov 1 shows both.

## Root cause

**Bug A: service-date filter (review finding C1).**
`loader.py _build_active_service_ids()` kept only trips whose `service_id` was
active on "today +/- 1 day", computed as `datetime.now(tz=UTC).date()`: UTC,
not agency time. The set was built only inside `load()`, which ran only when
the GTFS bundle's version changed. When the agency skipped a republish (or the
version string did not change), the window expired date by date and every
service silently fell out of the lookups. The damage begins at the service-day
rollover because GTFS times past midnight (24:00:00 to 26:00:00) keep the
previous day's trips matching until about 02:00 ET, which is the observed
collapse boundary on Oct 13, 19, 24 and Nov 1. Recovery could only come from a
fresh bundle rebuilding the filter, which is why heals happened at irregular
hours (Oct 14 evening, Oct 24 18:00 ET, Nov 2 16:00 ET).

**Bug B: DST anchoring.** `resolve_scheduled_datetime()` anchored schedule
times with `midnight = actual_eastern.normalize()` and then `midnight +
offset`. A timezone-aware `Timestamp + timedelta` adds absolute time, not wall
time. On the 25-hour day (America/New_York, 2026-11-01) that resolves every
scheduled time after the fall-back one hour early. Deviations then measured
about +3600 s and the consumer's 30-minute acceptance gate silently dropped
the results: the whole post-transition service day produced near-zero output.
On normal 24-hour days the old math is indistinguishable from the correct one,
which is why this hid since Sep 5.

Both bugs were silent by construction: no exception, no missing log line, just
a shrinking fraction of the truth.

## Fix

- **Bug A** (724a708, deployed 2026-11-04): the window is now computed from
  `_agency_today()` (`ZoneInfo(AGENCY_TZ)`), and `reload_if_changed()` also
  reloads when `service_date_stale()`: the agency-local date advanced past the
  date the filter was built for. A stopped-republishing bundle can no longer
  let the window expire; the filter rebuilds at every service-day rollover.
- **Bug B** (cbda73d, deployed 2026-11-04): anchor at noon minus 12 absolute
  hours per the GTFS spec, since noon is unambiguous on every day, with
  candidate days previous/same/next. Identical results to the old math on
  normal days. Regression tests (b3d2720, 10f1d45) cover the Nov 1 fall-back
  and the Mar 8 spring-forward.
- **Data repair (open)**: damaged days are recomputable from the raw archive
  for Oct 24, Nov 1 and Nov 2 in full (parquet + NDJSON retained). Oct 13-14
  and 19 are not recoverable (the archive started Oct 20).

## Alert that would have caught it

- **Rule 2: hourly deviation volume** (`HEALTHCHECKS_DATA_URL`, deployed
  2026-11-07) fires at the first hour close after the collapse starts, against
  the same hour last week. On Nov 1 the baseline (Oct 25) is a perfect
  same-weekday match. This is the primary catch for both bugs. Limits: skipped
  when the week-ago hour has fewer than 20 deviations (overnight hours), and
  judged only hourly, so a short blip can hide inside an hour that ends near
  baseline.
- **Rule 1: matched-ping ratio below 50% over 30 min** catches bug B within
  about 30 min of the fall-back (the gate turns matched pings into unmatched
  ones) and bug A as trips drop out of the lookups. But rule 1 could not fire
  in production until 2026-11-08 (coverage-check bug, see the skill pitfalls)
  and did not exist at all before Nov 7.
- **Dead-man ping (`HEALTHCHECKS_PING_URL`)**: would not have caught anything.
  Ingestion was healthy and the raw stream was complete all along. This
  incident is exactly the gap between "data arrives" and "data is processed".
- **Daily ops report**: saw the Nov 2 lull and classified it as a blip. The
  volume-vs-weekday-baseline check belongs in the report's verdict line, not
  just in raw numbers.
- **Still missing (recommended)**: (1) a route-coverage anomaly check, active
  routes/hour vs the same hour's 7-day baseline, since bug A's signature is
  volume loss with normal values; (2) a raw-vs-processed cross-check, archive
  lines/hour vs deviations/hour divergence, which reads this incident's
  headline table automatically.
