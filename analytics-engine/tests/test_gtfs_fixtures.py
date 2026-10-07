"""
Loader tests against the curated real-world GTFS fixtures.

Unlike test_loader.py, these load the fixture feeds from 
tests/fixtures/gtfs/ and verify the loader handles
the quirks real feeds are known to contain, gracefully:

- feeds with no calendar.txt (service periods only in calendar_dates.txt)
- stops with missing/broken coordinates
- duplicate trip_id rows in trips.txt
- empty route_long_name values
- stop_times.txt rows referencing trips absent from trips.txt
- past-midnight times (>= 24:00:00) and non-numeric trip_ids

Fixture provenance and the quirk matrix live in tests/fixtures/gtfs/README.md.
These tests need no Docker and run in the regular unit-test CI job.
"""

from __future__ import annotations

import re

import pytest

from gtfs_fixtures import (
    ALL_FIXTURES,
    FIXTURES_DIR,
    MAX_FIXTURE_BYTES,
    read_rows,
)
from gtfs_static.loader import GtfsStaticData
from metrics.schedule_deviation import gtfs_time_to_seconds

TIME_RE = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})$")


class TestEveryFixtureLoads:
    """The baseline contract: every curated feed loads without raising and
    produces non-empty lookups, with the service-day filter neither crashing
    nor silently dropping trips (all fixture service periods are expired, so
    the filter must fall back to keeping every trip)."""

    @pytest.mark.parametrize("name", ALL_FIXTURES)
    def test_loads_and_builds_all_lookups(self, gtfs_fixture, name):
        data = GtfsStaticData(gtfs_fixture(name))
        data.load()

        assert data.direction_lookup
        assert data.stop_times_lookup
        assert data.stops_lookup
        assert data.routes_lookup
        assert data.trip_route_lookup

    @pytest.mark.parametrize("name", ALL_FIXTURES)
    def test_every_trip_in_the_feed_survives_the_service_day_filter(
        self, gtfs_fixture, name
    ):
        """All fixture service periods are in the past, so the loader's
        active-service filter must be a no-op (it falls back to keeping all
        trips when nothing runs today). This is what makes the fixture-based
        tests deterministic regardless of run date."""
        feed_dir = gtfs_fixture(name)
        trips = read_rows(feed_dir, "trips.txt")
        expected = {
            row["trip_id"] for row in trips if row["direction_id"] in ("0", "1")
        }

        data = GtfsStaticData(feed_dir)
        data.load()

        assert set(data.direction_lookup) == expected

    def test_fixture_archives_stay_under_the_repo_size_budget(self):
        """Guards against fixture creep: each curated feed must stay under the
        1 MB compressed budget documented in tests/fixtures/gtfs/README.md."""
        archives = sorted(FIXTURES_DIR.glob("*.zip"))
        assert {a.stem for a in archives} == set(ALL_FIXTURES)
        oversized = [a.name for a in archives if a.stat().st_size >= MAX_FIXTURE_BYTES]
        assert not oversized, f"fixtures over {MAX_FIXTURE_BYTES} bytes: {oversized}"


class TestMissingCalendarQuirk:
    """wmata-2026-04-29.zip: service periods live only in calendar_dates.txt.
    The loader must not require calendar.txt and must not filter trips away."""

    def test_fixture_really_has_no_calendar_txt(self, gtfs_fixture):
        feed_dir = gtfs_fixture("wmata-2026-04-29")
        assert not (feed_dir / "calendar.txt").exists()
        assert (feed_dir / "calendar_dates.txt").exists()

    def test_loads_all_trips_without_calendar_txt(self, gtfs_fixture):
        feed_dir = gtfs_fixture("wmata-2026-04-29")
        trips = read_rows(feed_dir, "trips.txt")

        data = GtfsStaticData(feed_dir)
        data.load()

        assert len(data.direction_lookup) == len(trips) == 5393

    def test_feed_info_without_feed_version_falls_back_to_file_fingerprint(
        self, gtfs_fixture
    ):
        # Real WMATA feed_info.txt has no feed_version column, so the loader's
        # authoritative version signal is unavailable and the file fingerprint
        # fallback must kick in (has_changed() depends on it).
        data = GtfsStaticData(gtfs_fixture("wmata-2026-04-29"))
        data.load()

        assert (data._current_version or "").startswith("fingerprint:")


class TestBrokenCoordinateQuirk:
    """mbta-2019-07-25.zip: 1147 generic "node-*-platform" stops have blank
    latitude/longitude. The loader must keep them as StopInfo with None
    coordinates (downstream enrichment skips location for those), not crash or
    coerce blanks to 0.0."""

    def test_blank_coordinate_stops_load_with_none_coordinates(self, gtfs_fixture):
        feed_dir = gtfs_fixture("mbta-2019-07-25")
        raw_stops = read_rows(feed_dir, "stops.txt")
        blank_ids = {
            row["stop_id"] for row in raw_stops if not row["stop_lat"].strip()
        }
        assert blank_ids  # fixture must keep the quirk density (1147 rows)
        assert len(blank_ids) == 1147

        data = GtfsStaticData(feed_dir)
        data.load()

        for stop_id in blank_ids:
            info = data.stops_lookup[stop_id]
            assert info.stop_lat is None
            assert info.stop_lon is None
        # A known generic node from the snapshot, spot-checked explicitly.
        assert data.stops_lookup["node-123-platform"].stop_name == "Andrew"

    def test_normal_stops_still_have_real_coordinates(self, gtfs_fixture):
        data = GtfsStaticData(gtfs_fixture("mbta-2019-07-25"))
        data.load()

        located = [
            s for s in data.stops_lookup.values()
            if s.stop_lat is not None and s.stop_lon is not None
        ]
        assert located
        for info in located:
            assert info.stop_lat is not None and info.stop_lon is not None
            assert -74.0 < info.stop_lon < -69.0  # Massachusetts-ish
            assert 41.0 < info.stop_lat < 43.5

    def test_feed_version_from_feed_info_is_used(self, gtfs_fixture):
        # The MBTA snapshot ships feed_version in feed_info.txt -- the
        # authoritative version signal must win over the fingerprint fallback.
        data = GtfsStaticData(gtfs_fixture("mbta-2019-07-25"))
        data.load()

        assert (data._current_version or "").startswith("feed_version:")


class TestNonNumericTripIdQuirk:
    """Real feeds use trip_ids like "40526281-20:45-BraintreeNQuincyL" (MBTA)
    and "01SFO10SAT" (BART). Letting pandas infer dtypes would corrupt these."""

    @pytest.mark.parametrize("name", ["mbta-2019-07-25", "bart-2010"])
    def test_non_numeric_trip_ids_survive_intact(self, gtfs_fixture, name):
        feed_dir = gtfs_fixture(name)
        trips = read_rows(feed_dir, "trips.txt")
        weird = [row["trip_id"] for row in trips if not row["trip_id"].isdigit()]
        assert weird  # fixture must contain non-numeric trip_ids

        data = GtfsStaticData(feed_dir)
        data.load()

        sample = weird[0]
        assert sample in data.direction_lookup
        assert sample in data.trip_route_lookup
        assert any(key[0] == sample for key in data.stop_times_lookup)


class TestPastMidnightTimeQuirk:
    """GTFS allows times >= 24:00:00 for trips spanning midnight. bart-2010
    has 870 such stop_times rows. The loader pre-parses them to seconds that
    may exceed 24h instead of choking on them."""

    def test_past_midnight_rows_parse_to_seconds_beyond_24h(self, gtfs_fixture):
        feed_dir = gtfs_fixture("bart-2010")
        stop_times = read_rows(feed_dir, "stop_times.txt")

        def is_past_midnight(value: str) -> bool:
            match = TIME_RE.match(value.strip())
            return bool(match) and int(match.group(1)) >= 24

        late_rows = [
            row
            for row in stop_times
            if is_past_midnight(row["arrival_time"])
            or is_past_midnight(row["departure_time"])
        ]
        assert len(late_rows) == 870  # fixture must keep the quirk density

        data = GtfsStaticData(feed_dir)
        data.load()

        row = late_rows[0]
        entry = data.stop_times_lookup[(row["trip_id"], int(row["stop_sequence"]))]
        if is_past_midnight(row["arrival_time"]):
            assert entry.arrival_time is not None
            assert entry.arrival_time == gtfs_time_to_seconds(row["arrival_time"])
            assert entry.arrival_time >= 24 * 3600
        if is_past_midnight(row["departure_time"]):
            assert entry.departure_time is not None
            assert entry.departure_time == gtfs_time_to_seconds(row["departure_time"])
            assert entry.departure_time >= 24 * 3600


class TestEmptyRouteLongNameQuirk:
    """wmata-2026-04-29.zip: the SHUTTLE route has an empty route_long_name.
    The loader stores None so the API returns null consistently."""

    def test_empty_route_long_name_is_none_not_empty_string(self, gtfs_fixture):
        feed_dir = gtfs_fixture("wmata-2026-04-29")
        routes = read_rows(feed_dir, "routes.txt")
        empty_ids = {
            row["route_id"] for row in routes if not row["route_long_name"].strip()
        }
        assert empty_ids == {"SHUTTLE"}

        data = GtfsStaticData(feed_dir)
        data.load()

        assert data.routes_lookup["SHUTTLE"] is None
        # Named routes are unaffected.
        assert data.routes_lookup["RED"] == "Red"


class TestDuplicateTripIdQuirk:
    """duplicate-trip-ids.zip: trips.txt contains two rows with the same
    trip_id (upstream marks the second with DuplicateIDError). The loader must
    not crash; the dict-based lookups naturally collapse to one entry per
    trip_id (last row wins)."""

    def test_duplicate_trip_rows_collapse_gracefully(self, gtfs_fixture):
        feed_dir = gtfs_fixture("duplicate-trip-ids")
        trips = read_rows(feed_dir, "trips.txt")
        trip_ids = [row["trip_id"] for row in trips]
        assert len(trip_ids) == 2 and len(set(trip_ids)) == 1  # the quirk

        data = GtfsStaticData(feed_dir)
        data.load()

        (duplicated,) = set(trip_ids)
        assert duplicated in data.direction_lookup
        assert len(data.direction_lookup) == 1
        # Its stop_times rows are untouched by the duplicate.
        assert len(data.stop_times_lookup) == 3
        assert data.trip_route_lookup[duplicated] == "03"


class TestOrphanStopTimesQuirk:
    """orphan-stop-times.zip: stop_times.txt has rows referencing trip "xyz",
    which does not exist in trips.txt. The loader keeps the scheduled rows (so
    nothing is silently dropped) but the trip stays unlinked in the trip-level
    lookups -- which is exactly what consumer.py's enrichment path needs to
    degrade gracefully to route_id=None / no location."""

    def test_orphan_rows_are_kept_but_unlinked(self, gtfs_fixture):
        feed_dir = gtfs_fixture("orphan-stop-times")
        stop_times = read_rows(feed_dir, "stop_times.txt")
        trip_ids = {row["trip_id"] for row in read_rows(feed_dir, "trips.txt")}
        orphans = [row for row in stop_times if row["trip_id"] not in trip_ids]
        assert [row["trip_id"] for row in orphans] == ["xyz"]  # the quirk

        data = GtfsStaticData(feed_dir)
        data.load()

        # Kept in the schedule lookup, keyed like any other row...
        row = orphans[0]
        key = ("xyz", int(row["stop_sequence"]))
        assert data.stop_times_lookup[key].trip_id == "xyz"

        # ...but absent from the trip-level lookups, so enrichment lookups
        # (trip_route_lookup.get / direction_lookup.get) return None and the
        # consumer skips enrichment instead of crashing.
        assert "xyz" not in data.direction_lookup
        assert "xyz" not in data.trip_route_lookup
