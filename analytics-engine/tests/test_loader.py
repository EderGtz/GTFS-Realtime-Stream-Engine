"""
Unit tests for gtfs_static/loader.py.

Uses tiny synthetic GTFS files written to tmp_path rather than the real MBTA
bundle. Fixed, known inputs with known expected outputs, matching this
project's existing testing convention.
"""

import time

import pandas as pd
import pytest

from gtfs_static.loader import GtfsStaticData, StopInfo

@pytest.fixture
def gtfs_dir(tmp_path):
    """A minimal, valid 3-file GTFS bundle, plus one deliberately messy row per
    file to exercise the real quirks this loader has to handle."""
    stops = pd.DataFrame([
        {"stop_id": "70001", "stop_name": "Alewife", "stop_lat": 42.3954, "stop_lon": -71.1425},
        {"stop_id": "70002", "stop_name": "Davis", "stop_lat": 42.3968, "stop_lon": -71.1218},
    ])
    stops.to_csv(tmp_path / "stops.txt", index=False)

    trips = pd.DataFrame([
        {"trip_id": "12345678", "route_id": "Red", "direction_id": 0},
        {"trip_id": "ADDED-1584904727", "route_id": "Red", "direction_id": 1},  # alphanumeric, real-time-added
        {"trip_id": "no_direction_trip", "route_id": "Red", "direction_id": None},  # missing direction
    ])
    trips.to_csv(tmp_path / "trips.txt", index=False)

    stop_times = pd.DataFrame([
        {"trip_id": "12345678", "stop_sequence": 1, "arrival_time": None, "departure_time": "08:00:00"},
        {"trip_id": "12345678", "stop_sequence": 2, "arrival_time": "08:05:00", "departure_time": "08:05:30"},
        {"trip_id": "ADDED-1584904727", "stop_sequence": 1, "arrival_time": "25:10:00", "departure_time": "25:10:30"},
    ])
    stop_times.to_csv(tmp_path / "stop_times.txt", index=False)

    return tmp_path


class TestLoad:
    def test_builds_direction_lookup_for_valid_trips(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        data.load()

        assert data.direction_lookup["12345678"] == 0
        assert data.direction_lookup["ADDED-1584904727"] == 1

    def test_excludes_trips_with_missing_direction_id(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        data.load()

        assert "no_direction_trip" not in data.direction_lookup

    def test_alphanumeric_trip_id_is_preserved_as_a_string_not_corrupted(self, gtfs_dir):
        # should not get coerced to NaN or truncated by numeric type inference.
        data = GtfsStaticData(gtfs_dir)
        data.load()

        assert "ADDED-1584904727" in data.direction_lookup
        key = ("ADDED-1584904727", 1)
        assert key in data.stop_times_lookup
        assert data.stop_times_lookup[key].trip_id == "ADDED-1584904727"

    def test_builds_stop_times_lookup_keyed_by_trip_and_sequence(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        data.load()

        assert len(data.stop_times_lookup) == 3
        entry = data.stop_times_lookup[("12345678", 2)]
        assert entry.arrival_time == "08:05:00"
        assert entry.departure_time == "08:05:30"

    def test_blank_arrival_time_is_none_not_a_string(self, gtfs_dir):
        # Trip-origin stops commonly have only a departure_time -- schedule_deviation.py
        # relies on this being a real None, not an empty string or NaN float, to
        # correctly skip arrival scoring for these rows.
        data = GtfsStaticData(gtfs_dir)
        data.load()

        entry = data.stop_times_lookup[("12345678", 1)]
        assert entry.arrival_time is None
        assert entry.departure_time == "08:00:00"

    def test_preserves_past_midnight_time_strings_unparsed(self, gtfs_dir):
        # GTFS times >= 24:00:00 must pass through untouched. Parsing them is
        # resolve_scheduled_datetime's job, not this loader's.
        data = GtfsStaticData(gtfs_dir)
        data.load()

        entry = data.stop_times_lookup[("ADDED-1584904727", 1)]
        assert entry.arrival_time == "25:10:00"

    def test_builds_stops_lookup(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        data.load()

        assert data.stops_lookup["70001"] == StopInfo(
            stop_id="70001", stop_name="Alewife", stop_lat=42.3954, stop_lon=-71.1425
        )

    def test_raises_clearly_when_a_required_file_is_missing(self, tmp_path):
        (tmp_path / "stops.txt").write_text("stop_id\n1\n")
        # trips.txt and stop_times.txt deliberately absent

        data = GtfsStaticData(tmp_path)
        with pytest.raises(FileNotFoundError, match="trips.txt"):
            data.load()

    def test_failed_reload_preserves_previous_snapshot(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        data.load()

        original_direction_lookup = data.direction_lookup.copy()
        original_stop_times_lookup = data.stop_times_lookup.copy()
        original_stops_lookup = data.stops_lookup.copy()
        original_version = data._current_version

        # Corrupt the schema of trips.txt.
        trips = pd.DataFrame([
            {
                "trip_id": "99999999",
                "route_id": "Red",
                # direction_id intentionally missing
            },
        ])
        trips.to_csv(gtfs_dir / "trips.txt", index=False)

        with pytest.raises(ValueError):
            data.load()

        assert data.direction_lookup == original_direction_lookup
        assert data.stop_times_lookup == original_stop_times_lookup
        assert data.stops_lookup == original_stops_lookup
        assert data._current_version == original_version



class TestHasChanged:
    def test_true_before_the_first_load(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        assert data.has_changed() is True

    def test_false_immediately_after_loading_with_no_file_changes(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        data.load()
        assert data.has_changed() is False

    def test_true_after_a_required_file_is_modified(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        data.load()

        time.sleep(0.01)
        updated_trips = pd.DataFrame([
            {"trip_id": "99999999", "route_id": "Blue", "direction_id": 0},
        ])
        updated_trips.to_csv(gtfs_dir / "trips.txt", index=False)

        assert data.has_changed() is True

    def test_reload_if_changed_actually_reloads_and_returns_true(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        data.load()
        assert "12345678" in data.direction_lookup

        time.sleep(0.01)
        updated_trips = pd.DataFrame([
            {"trip_id": "99999999", "route_id": "Blue", "direction_id": 0},
        ])
        updated_trips.to_csv(gtfs_dir / "trips.txt", index=False)

        reloaded = data.reload_if_changed()

        assert reloaded is True
        assert "99999999" in data.direction_lookup
        assert "12345678" not in data.direction_lookup  # old snapshot fully replaced

    def test_reload_if_changed_does_nothing_when_nothing_changed(self, gtfs_dir):
        data = GtfsStaticData(gtfs_dir)
        data.load()
        assert data.reload_if_changed() is False

    def test_feed_version_change_is_detected_even_if_the_three_files_are_untouched(self, gtfs_dir):
        # feed_info.txt is the authoritative version signal when present -- must
        # take priority over the file-fingerprint fallback.
        pd.DataFrame([{"feed_publisher_name": "MBTA", "feed_version": "2026-08-01"}]).to_csv(
            gtfs_dir / "feed_info.txt", index=False
        )

        data = GtfsStaticData(gtfs_dir)
        data.load()
        assert data.has_changed() is False

        pd.DataFrame([{"feed_publisher_name": "MBTA", "feed_version": "2026-09-01"}]).to_csv(
            gtfs_dir / "feed_info.txt", index=False
        )
        assert data.has_changed() is True

    def test_falls_back_to_fingerprint_when_feed_version_column_is_missing(
        self, gtfs_dir
    ):
        pd.DataFrame([
            {"feed_publisher_name": "MBTA"},
        ]).to_csv(gtfs_dir / "feed_info.txt", index=False)

        data = GtfsStaticData(gtfs_dir)
        data.load()
        version = data._current_version

        assert version is not None
        assert version.startswith("fingerprint:")

    def test_falls_back_to_fingerprint_when_feed_info_is_empty(self, gtfs_dir):
        (gtfs_dir / "feed_info.txt").write_text("")

        data = GtfsStaticData(gtfs_dir)
        data.load()
        version = data._current_version

        assert version is not None
        assert version.startswith("fingerprint:")



class TestSchemaValidation:
    def test_raises_when_required_trips_column_is_missing(self, gtfs_dir):
        trips = pd.DataFrame([
            {
                "trip_id": "12345678",
                "route_id": "Red",
                # direction_id intentionally missing
            },
        ])
        trips.to_csv(gtfs_dir / "trips.txt", index=False)

        data = GtfsStaticData(gtfs_dir)

        with pytest.raises(
            ValueError,
            match=r"Missing required column\(s\) in trips\.txt:.*direction_id",
        ):
            data.load()

    def test_raises_when_required_stop_times_column_is_missing(self, gtfs_dir):
        stop_times = pd.DataFrame([
            {
                "trip_id": "12345678",
                "stop_sequence": 1,
                "arrival_time": "08:00:00",
                # departure_time intentionally missing
            },
        ])
        stop_times.to_csv(gtfs_dir / "stop_times.txt", index=False)

        data = GtfsStaticData(gtfs_dir)

        with pytest.raises(
            ValueError,
            match=r"Missing required column\(s\) in stop_times\.txt:.*departure_time",
        ):
            data.load()

    def test_raises_when_required_stops_column_is_missing(self, gtfs_dir):
        stops = pd.DataFrame([
            {
                # stop_id intentionally missing
                "stop_name": "Alewife",
                "stop_lat": 42.3954,
                "stop_lon": -71.1425,
            },
        ])
        stops.to_csv(gtfs_dir / "stops.txt", index=False)

        data = GtfsStaticData(gtfs_dir)

        with pytest.raises(
            ValueError,
            match=r"Missing required column\(s\) in stops\.txt:.*stop_id",
        ):
            data.load()
