"""
Unit tests for metrics/bunching.py.

Each test targets one specific decision made in 04_bunching.ipynb, using fixed
synthetic inputs with known expected outputs -- not live data.
"""

import pandas as pd
import pytest

from metrics.bunching import (
    detect_bunching_events,
    displacement_meters,
    find_close_pairs,
)

EASTERN = "America/New_York"


def eastern_ts(s: str) -> pd.Timestamp:
    return pd.Timestamp(s, tz=EASTERN)


class TestDisplacementMeters:
    def test_one_degree_latitude_is_approximately_111km(self):
        # Sanity check against the well-known ~111.32km/degree constant used
        # throughout notebooks 01/02/04.
        dist = displacement_meters(42.0, -71.0, 43.0, -71.0)
        assert dist == pytest.approx(111_320, abs=50)

    def test_zero_distance_for_identical_points(self):
        assert displacement_meters(42.35, -71.05, 42.35, -71.05) == pytest.approx(0.0)

    def test_longitude_compression_at_boston_latitude(self):
        # At ~42N, one degree of longitude is roughly 74% as long as one degree of
        # latitude -- this is precisely the distortion notebook 02 caught and fixed.
        lat_degree_dist = displacement_meters(42.0, -71.0, 43.0, -71.0)
        lon_degree_dist = displacement_meters(42.0, -71.0, 42.0, -70.0)
        ratio = lon_degree_dist / lat_degree_dist
        assert 0.70 < ratio < 0.78


@pytest.fixture
def same_direction_close_pings() -> pd.DataFrame:
    """Two vehicles, same route, same direction, ~15m apart, over 3 consecutive
    15-second poll buckets -- a genuine, persistent bunching case."""
    rows = []
    base = eastern_ts("2026-08-18 10:00:00")
    for i in range(3):
        t = base + pd.Timedelta(seconds=15 * i)
        rows.append({"vehicle_id": "A", "trip_id": "t_north", "route_id": "R1",
                     "lat": 42.0 + 0.00001 * i, "lon": -71.0, "timestamp_eastern": t})
        rows.append({"vehicle_id": "B", "trip_id": "t_north_2", "route_id": "R1",
                     "lat": 42.0001 + 0.00001 * i, "lon": -71.0, "timestamp_eastern": t})
    return pd.DataFrame(rows)


class TestFindClosePairs:
    def test_pairs_same_direction_close_vehicles(self, same_direction_close_pings):
        direction_lookup = {"t_north": 0, "t_north_2": 0}
        pairs = find_close_pairs(same_direction_close_pings, direction_lookup)
        assert len(pairs) == 3  # one match per time bucket

    def test_excludes_opposite_direction_vehicles_even_when_close(self):
        # The central design decision from notebook 04, Section B: same route is
        # not sufficient -- opposite-direction vehicles passing each other must
        # never be flagged, no matter how close.
        pings = pd.DataFrame([
            {"vehicle_id": "A", "trip_id": "t_north", "route_id": "R1",
             "lat": 42.0, "lon": -71.0, "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
            {"vehicle_id": "B", "trip_id": "t_south", "route_id": "R1",
             "lat": 42.0001, "lon": -71.0001, "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
        ])
        direction_lookup = {"t_north": 0, "t_south": 1}
        pairs = find_close_pairs(pings, direction_lookup)
        assert len(pairs) == 0

    def test_excludes_different_routes(self):
        pings = pd.DataFrame([
            {"vehicle_id": "A", "trip_id": "t1", "route_id": "R1",
             "lat": 42.0, "lon": -71.0, "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
            {"vehicle_id": "B", "trip_id": "t2", "route_id": "R2",
             "lat": 42.0001, "lon": -71.0001, "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
        ])
        direction_lookup = {"t1": 0, "t2": 0}
        pairs = find_close_pairs(pings, direction_lookup)
        assert len(pairs) == 0

    def test_excludes_pairs_beyond_the_distance_threshold(self):
        pings = pd.DataFrame([
            {"vehicle_id": "A", "trip_id": "t1", "route_id": "R1",
             "lat": 42.0, "lon": -71.0, "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
            {"vehicle_id": "B", "trip_id": "t1", "route_id": "R1",
             "lat": 42.01, "lon": -71.0, "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},  # ~1.1km away
        ])
        direction_lookup = {"t1": 0}
        pairs = find_close_pairs(pings, direction_lookup, distance_threshold_m=100)
        assert len(pairs) == 0

    def test_excludes_trips_missing_from_direction_lookup(self):
        # Simulates a trip whose direction_id couldn't be resolved (e.g. a
        # Shuttle-Generic*/no-schedule trip, per notebook 04 Section A).
        pings = pd.DataFrame([
            {"vehicle_id": "A", "trip_id": "unknown_trip", "route_id": "R1",
             "lat": 42.0, "lon": -71.0, "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
        ])
        pairs = find_close_pairs(pings, direction_lookup={})
        assert len(pairs) == 0


class TestFindClosePairsBucketCollision:
    """
    Regression tests for a real bug found via notebook 04's cluster investigation:
    a single vehicle can produce two genuinely distinct pings (different real
    timestamps, slightly different position) that floor into the SAME time_bucket
    due to ordinary poll jitter (notebook 01 found median cadence ~15.2s, not
    exactly 15s). Before the fix, this let a vehicle pair against itself, which
    surfaced downstream as an impossible size-1 "cluster" after union-find in
    notebook 04's depot investigation (a connected component can never be smaller
    than 2 -- getting one meant a self-pair had been produced upstream).
    """

    def test_vehicle_never_pairs_against_itself_on_bucket_collision(self):
        # Two DISTINCT real pings from the SAME vehicle, 5 seconds apart, both
        # floor into the identical 15-second bucket.
        pings = pd.DataFrame([
            {"vehicle_id": "A", "trip_id": "t1", "route_id": "R1",
             "lat": 42.00000, "lon": -71.00000,
             "timestamp_eastern": eastern_ts("2026-08-18 10:00:01")},
            {"vehicle_id": "A", "trip_id": "t1", "route_id": "R1",
             "lat": 42.00002, "lon": -71.00000,  # vehicle moved slightly
             "timestamp_eastern": eastern_ts("2026-08-18 10:00:06")},
        ])
        direction_lookup = {"t1": 0}

        pairs = find_close_pairs(pings, direction_lookup)

        # No pair should exist where both sides are the same vehicle_id, no matter
        # how the two colliding rows get labeled internally.
        self_pairs = pairs[pairs["vehicle_a"] == pairs["vehicle_b"]] if len(pairs) else pairs
        assert len(self_pairs) == 0

    def test_bucket_collision_does_not_duplicate_a_real_pair(self):
        # Vehicle A produces two pings that collide into one bucket; vehicle B (a
        # genuinely different vehicle) is close to A in that same bucket. Without
        # deduping A's colliding pings first, this can produce TWO rows for the
        # same (A, B) pair within a single time_bucket -- which corrupts
        # detect_bunching_events' consecutive-run detection, since it assumes at
        # most one row per (pair, time_bucket).
        pings = pd.DataFrame([
            {"vehicle_id": "A", "trip_id": "t1", "route_id": "R1",
             "lat": 42.00000, "lon": -71.00000,
             "timestamp_eastern": eastern_ts("2026-08-18 10:00:01")},
            {"vehicle_id": "A", "trip_id": "t1", "route_id": "R1",
             "lat": 42.00001, "lon": -71.00000,
             "timestamp_eastern": eastern_ts("2026-08-18 10:00:06")},
            {"vehicle_id": "B", "trip_id": "t1", "route_id": "R1",
             "lat": 42.00003, "lon": -71.00000,
             "timestamp_eastern": eastern_ts("2026-08-18 10:00:03")},
        ])
        direction_lookup = {"t1": 0}

        pairs = find_close_pairs(pings, direction_lookup)
        ab_pairs = pairs[(pairs["vehicle_a"] == "A") & (pairs["vehicle_b"] == "B")]

        # Exactly one (A, B) observation for this single time_bucket, not two.
        assert len(ab_pairs) == 1

    def test_distinct_vehicles_in_the_same_bucket_still_pair_normally(self):
        # Sanity check that the collision fix doesn't over-correct and start
        # dropping legitimate distinct-vehicle pairs.
        pings = pd.DataFrame([
            {"vehicle_id": "A", "trip_id": "t1", "route_id": "R1",
             "lat": 42.00000, "lon": -71.00000,
             "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
            {"vehicle_id": "B", "trip_id": "t1", "route_id": "R1",
             "lat": 42.00001, "lon": -71.00000,
             "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
        ])
        direction_lookup = {"t1": 0}

        pairs = find_close_pairs(pings, direction_lookup)
        assert len(pairs) == 1
        assert pairs.iloc[0]["vehicle_a"] == "A"
        assert pairs.iloc[0]["vehicle_b"] == "B"

class TestDetectBunchingEvents:
    def test_persistent_proximity_becomes_one_event(self, same_direction_close_pings):
        direction_lookup = {"t_north": 0, "t_north_2": 0}
        close_pairs = find_close_pairs(same_direction_close_pings, direction_lookup)
        events = detect_bunching_events(close_pairs, min_consecutive=2)
        assert len(events) == 1
        assert events[0].observation_count == 3

    def test_single_momentary_close_ping_is_not_an_event(self):
        # The core purpose of the persistence requirement (notebook 04, Section B):
        # a lone close observation must not count as bunching.
        pings = pd.DataFrame([
            {"vehicle_id": "A", "trip_id": "t_north", "route_id": "R1",
             "lat": 42.0, "lon": -71.0, "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
            {"vehicle_id": "B", "trip_id": "t_north_2", "route_id": "R1",
             "lat": 42.0001, "lon": -71.0, "timestamp_eastern": eastern_ts("2026-08-18 10:00:00")},
        ])
        direction_lookup = {"t_north": 0, "t_north_2": 0}
        close_pairs = find_close_pairs(pings, direction_lookup)
        events = detect_bunching_events(close_pairs, min_consecutive=2)
        assert events == []

    def test_a_gap_in_proximity_splits_into_separate_events(self):
        # Two separate 2-bucket runs, with a non-close bucket in between --
        # must be counted as two distinct events, not one continuous one.
        rows = []
        base = eastern_ts("2026-08-18 10:00:00")
        close_offsets = [0, 1, 3, 4]     # buckets 2 (index) is intentionally far apart
        far_offset = 2
        for i in close_offsets:
            t = base + pd.Timedelta(seconds=15 * i)
            rows.append({"vehicle_id": "A", "trip_id": "t_north", "route_id": "R1",
                         "lat": 42.0, "lon": -71.0, "timestamp_eastern": t})
            rows.append({"vehicle_id": "B", "trip_id": "t_north_2", "route_id": "R1",
                         "lat": 42.0001, "lon": -71.0, "timestamp_eastern": t})
        t_far = base + pd.Timedelta(seconds=15 * far_offset)
        rows.append({"vehicle_id": "A", "trip_id": "t_north", "route_id": "R1",
                     "lat": 42.0, "lon": -71.0, "timestamp_eastern": t_far})
        rows.append({"vehicle_id": "B", "trip_id": "t_north_2", "route_id": "R1",
                     "lat": 42.02, "lon": -71.0, "timestamp_eastern": t_far})  # far apart this bucket

        pings = pd.DataFrame(rows)
        direction_lookup = {"t_north": 0, "t_north_2": 0}
        close_pairs = find_close_pairs(pings, direction_lookup)
        events = detect_bunching_events(close_pairs, min_consecutive=2)
        assert len(events) == 2
        assert all(e.observation_count == 2 for e in events)
