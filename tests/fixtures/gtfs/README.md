# Curated GTFS test fixtures

Real-world GTFS feeds used by the integration test suites
(`analytics-engine/tests/test_integration.py`,
`ingestion-service/tests/integration/api.test.ts`) and by the loader quirk tests
(`analytics-engine/tests/test_gtfs_fixtures.py`).

Before these existed, every test ran on tiny hand-written DataFrames, so nothing
ever exercised the quirks real feeds actually contain. The hand-crafted
`gtfs_dir` fixture in `analytics-engine/tests/test_loader.py` stays since it is the
right tool for fast, isolated unit tests. These feeds are for everything that
should see real data.

## Sources

Curated from the two entries in awesome-transit's
["Sample GTFS and GTFS Realtime datasets used for software testing"](https://github.com/MobilityData/awesome-transit#sample-gtfs-and-gtfs-realtime-datasets-used-for-software-testing)
section:

- [interline-io/transitland-lib](https://github.com/interline-io/transitland-lib) `testdata/`
  ("Transitland GTFS and GTFS Realtime unit tests") — real agency feed
  snapshots and the `gtfs-validator-layers` error feeds.
- The real feeds inside that testdata are covered by their own licenses
  (see `testdata/server/gtfs/licenses.md` upstream): MBTA under the
  [MBTA developers license](https://github.com/mbta/gtfs-documentation/blob/master/developers-license-agreement.pdf),
  BART under the [BART developer license agreement](https://www.bart.gov/schedules/developers/developer-license-agreement).
  WMATA data is used under WMATA's open data terms. These fixtures exist
  solely as test data for this repository.

## Fixtures and the quirks they cover

| Fixture | Origin | Rows (trips / stop_times / stops) | Quirks it exercises |
|---|---|---|---|
| `mbta-2019-07-25.zip` | Real MBTA snapshot 2019-07-25, trimmed to routes `1`, `28`, `Red` | 3,271 / 70,509 / 1,311 | 1,147 stops with blank coordinates (MBTA generic `node-*-platform` entries); non-numeric trip_ids containing colons (e.g. `40526281-20:45-BraintreeNQuincyL`); 3,337 past-midnight stop_times rows; `feed_info.txt` with `feed_version` |
| `wmata-2026-04-29.zip` | Real WMATA snapshot 2026-04-29, trimmed to Metrorail `RED` + `SHUTTLE` | 5,393 / 89,824 / 36 | **No `calendar.txt`** (service periods live only in `calendar_dates.txt`); **empty `route_long_name`** (`SHUTTLE`); `feed_info.txt` without `feed_version` (forces the fingerprint fallback); 3,543 past-midnight rows |
| `bart-2010.zip` | Real BART snapshot (2010-era), verbatim (upstream: `server/gtfs/bart-errors.zip`) | 2,513 / 31,932 / 48 | 870 past-midnight stop_times rows (times `>= 24:00:00`); alphanumeric trip_ids (`01SFO10SAT`); no `feed_info.txt` |
| `duplicate-trip-ids.zip` | transitland-lib `gtfs-validator-layers/base/` + their `trips-duplicate` error overlay | 2 rows, 1 unique trip / 3 / 3 | **Duplicate `trip_id` rows in `trips.txt`** (upstream marks the second row `DuplicateIDError`) |
| `orphan-stop-times.zip` | transitland-lib `gtfs-validator-layers/base/` + their `stop_times-unknown-trip_id` error overlay | 1 / 3 / 3 | **`stop_times.txt` rows referencing a `trip_id` absent from `trips.txt`** (row for trip `xyz`) |

Named quirks this project has been bitten by: missing `calendar.txt` ✓ (wmata),
broken coordinates ✓ (mbta), duplicate trip_ids ✓ (duplicate-trip-ids),
empty route_long_name ✓ (wmata), orphan stop_times rows ✓ (orphan-stop-times).
Past-midnight times and non-numeric trip_ids are covered as a bonus — both are
quirks this codebase has already been bitten by (see the loader and
`schedule_deviation.py` docstrings).

## Curation rules (see `curate_fixtures.py`)

Every kept row is verbatim from upstream; rows are only ever dropped, never
edited. Per feed:

- **mbta**: keep all rows of `agency/calendar/calendar_dates/feed_info/routes.txt`;
  keep trips of routes `1`, `28`, `Red` and only their `stop_times` rows; keep
  stops referenced by those rows **plus every stop with a blank latitude** (this
  preserves the full feed's 1,147 broken-coordinate rows instead of sampling
  them away). Everything else (`shapes.txt`, `pathways.txt`, `facilities*.txt`,
  …) is dropped to fit the budget.
- **wmata**: same trimming for routes `RED` + `SHUTTLE`; referenced stops only;
  `calendar.txt` intentionally absent (upstream has none).
- **bart**: byte-identical rows to upstream (rewritten through the same CSV
  round-trip; zip re-compressed).
- **validator-layer feeds**: upstream's `base/` feed with upstream's own error
  file swapped in — exactly how transitland-lib composes these fixtures in its
  validator tests. The extra `expect_error` metadata column is kept.

Budget: each fixture is under 1 MB compressed (enforced by `curate_fixtures.py`
and by a test).

## Determinism note

All fixtures are historical snapshots whose service periods (`calendar.txt` /
`calendar_dates.txt`) ended before October 2026. That matters because
`loader.py`'s service-day filter only keeps trips active today ± 1 day, and
falls back to "keep everything" when nothing is active. Tests that assert the
filter is a no-op (e.g. "wmata loads all 5,393 trips despite having no
`calendar.txt`") rely on those expired dates and are therefore stable for any
run date after the snapshots. If you re-curate from newer snapshots, re-check
that assumption.

## Rebuilding

```sh
git clone --depth 1 https://github.com/interline-io/transitland-lib.git
python3 curate_fixtures.py --source ./transitland-lib/testdata
```

The script is stdlib-only and deterministic (zip timestamps are normalized),
so a rebuild against the same upstream checkout produces byte-identical
fixtures.
