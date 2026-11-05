"""
Unit tests for metrics/bunching.py.

Each test targets one specific decision made in 04_bunching.ipynb, using fixed
synthetic inputs with known expected outputs -- not live data.
"""

import pandas as pd
import pytest

from gtfs_static.loader import StopInfo
from metrics.bunching import (
    _bucket,
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
        rows.append(
            {
                "vehicle_id": "A",
                "trip_id": "t_north",
                "route_id": "R1",
                "lat": 42.0 + 0.00001 * i,
                "lon": -71.0,
                "timestamp_eastern": t,
            }
        )
        rows.append(
            {
                "vehicle_id": "B",
                "trip_id": "t_north_2",
                "route_id": "R1",
                "lat": 42.0001 + 0.00001 * i,
                "lon": -71.0,
                "timestamp_eastern": t,
            }
        )
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
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "A",
                    "trip_id": "t_north",
                    "route_id": "R1",
                    "lat": 42.0,
                    "lon": -71.0,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
                {
                    "vehicle_id": "B",
                    "trip_id": "t_south",
                    "route_id": "R1",
                    "lat": 42.0001,
                    "lon": -71.0001,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
            ]
        )
        direction_lookup = {"t_north": 0, "t_south": 1}
        pairs = find_close_pairs(pings, direction_lookup)
        assert len(pairs) == 0

    def test_excludes_different_routes(self):
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "A",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.0,
                    "lon": -71.0,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
                {
                    "vehicle_id": "B",
                    "trip_id": "t2",
                    "route_id": "R2",
                    "lat": 42.0001,
                    "lon": -71.0001,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
            ]
        )
        direction_lookup = {"t1": 0, "t2": 0}
        pairs = find_close_pairs(pings, direction_lookup)
        assert len(pairs) == 0

    def test_excludes_pairs_beyond_the_distance_threshold(self):
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "A",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.0,
                    "lon": -71.0,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
                {
                    "vehicle_id": "B",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.01,
                    "lon": -71.0,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },  # ~1.1km away
            ]
        )
        direction_lookup = {"t1": 0}
        pairs = find_close_pairs(pings, direction_lookup, distance_threshold_m=100)
        assert len(pairs) == 0

    def test_excludes_trips_missing_from_direction_lookup(self):
        # Simulates a trip whose direction_id couldn't be resolved (e.g. a
        # Shuttle-Generic*/no-schedule trip, per notebook 04 Section A).
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "A",
                    "trip_id": "unknown_trip",
                    "route_id": "R1",
                    "lat": 42.0,
                    "lon": -71.0,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
            ]
        )
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
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "A",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.00000,
                    "lon": -71.00000,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:01"),
                },
                {
                    "vehicle_id": "A",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.00002,
                    "lon": -71.00000,  # vehicle moved slightly
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:06"),
                },
            ]
        )
        direction_lookup = {"t1": 0}

        pairs = find_close_pairs(pings, direction_lookup)

        # No pair should exist where both sides are the same vehicle_id, no matter
        # how the two colliding rows get labeled internally.
        self_pairs = (
            pairs[pairs["vehicle_a"] == pairs["vehicle_b"]] if len(pairs) else pairs
        )
        assert len(self_pairs) == 0

    def test_bucket_collision_does_not_duplicate_a_real_pair(self):
        # Vehicle A produces two pings that collide into one bucket; vehicle B (a
        # genuinely different vehicle) is close to A in that same bucket. Without
        # deduping A's colliding pings first, this can produce TWO rows for the
        # same (A, B) pair within a single time_bucket -- which corrupts
        # detect_bunching_events' consecutive-run detection, since it assumes at
        # most one row per (pair, time_bucket).
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "A",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.00000,
                    "lon": -71.00000,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:01"),
                },
                {
                    "vehicle_id": "A",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.00001,
                    "lon": -71.00000,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:06"),
                },
                {
                    "vehicle_id": "B",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.00003,
                    "lon": -71.00000,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:03"),
                },
            ]
        )
        direction_lookup = {"t1": 0}

        pairs = find_close_pairs(pings, direction_lookup)
        ab_pairs = pairs[(pairs["vehicle_a"] == "A") & (pairs["vehicle_b"] == "B")]

        # Exactly one (A, B) observation for this single time_bucket, not two.
        assert len(ab_pairs) == 1

    def test_distinct_vehicles_in_the_same_bucket_still_pair_normally(self):
        # Sanity check that the collision fix doesn't over-correct and start
        # dropping legitimate distinct-vehicle pairs.
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "A",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.00000,
                    "lon": -71.00000,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
                {
                    "vehicle_id": "B",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.00001,
                    "lon": -71.00000,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
            ]
        )
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
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "A",
                    "trip_id": "t_north",
                    "route_id": "R1",
                    "lat": 42.0,
                    "lon": -71.0,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
                {
                    "vehicle_id": "B",
                    "trip_id": "t_north_2",
                    "route_id": "R1",
                    "lat": 42.0001,
                    "lon": -71.0,
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
            ]
        )
        direction_lookup = {"t_north": 0, "t_north_2": 0}
        close_pairs = find_close_pairs(pings, direction_lookup)
        events = detect_bunching_events(close_pairs, min_consecutive=2)
        assert events == []

    def test_a_gap_in_proximity_splits_into_separate_events(self):
        # Two separate 2-bucket runs, with a non-close bucket in between --
        # must be counted as two distinct events, not one continuous one.
        rows = []
        base = eastern_ts("2026-08-18 10:00:00")
        close_offsets = [0, 1, 3, 4]  # buckets 2 (index) is intentionally far apart
        far_offset = 2
        for i in close_offsets:
            t = base + pd.Timedelta(seconds=15 * i)
            rows.append(
                {
                    "vehicle_id": "A",
                    "trip_id": "t_north",
                    "route_id": "R1",
                    "lat": 42.0,
                    "lon": -71.0,
                    "timestamp_eastern": t,
                }
            )
            rows.append(
                {
                    "vehicle_id": "B",
                    "trip_id": "t_north_2",
                    "route_id": "R1",
                    "lat": 42.0001,
                    "lon": -71.0,
                    "timestamp_eastern": t,
                }
            )
        t_far = base + pd.Timedelta(seconds=15 * far_offset)
        rows.append(
            {
                "vehicle_id": "A",
                "trip_id": "t_north",
                "route_id": "R1",
                "lat": 42.0,
                "lon": -71.0,
                "timestamp_eastern": t_far,
            }
        )
        rows.append(
            {
                "vehicle_id": "B",
                "trip_id": "t_north_2",
                "route_id": "R1",
                "lat": 42.02,
                "lon": -71.0,
                "timestamp_eastern": t_far,
            }
        )  # far apart this bucket

        pings = pd.DataFrame(rows)
        direction_lookup = {"t_north": 0, "t_north_2": 0}
        close_pairs = find_close_pairs(pings, direction_lookup)
        events = detect_bunching_events(close_pairs, min_consecutive=2)
        assert len(events) == 2
        assert all(e.observation_count == 2 for e in events)


class TestDSTAmbiguousHour:
    """Bunching must survive pings in the repeated fall-back hour. pandas
    Timestamp.floor rounds the wall clock and re-localizes it, raising
    "Cannot infer dst time from 2026-11-01 01:00:00" -- which aborted the
    bunching computation for every window containing such a ping (observed in
    production on 2026-11-01, hardening review)."""

    def test_bucket_does_not_raise_in_repeated_hour(self):
        first_pass = pd.Timestamp("2026-11-01 05:30", tz="UTC").tz_convert(
            EASTERN
        )  # 01:30 EDT
        second_pass = pd.Timestamp("2026-11-01 06:30", tz="UTC").tz_convert(
            EASTERN
        )  # 01:30 EST
        # The two passes of the repeated hour must land in distinct buckets.
        assert _bucket(first_pass) != _bucket(second_pass)

    def test_find_close_pairs_handles_repeated_hour_pings(self):
        first_pass = pd.Timestamp("2026-11-01 05:30", tz="UTC").tz_convert(
            EASTERN
        )  # 01:30 EDT
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "v1",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.0,
                    "lon": -71.0,
                    "timestamp_eastern": first_pass,
                },
                {
                    "vehicle_id": "v2",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.0,
                    "lon": -71.0,
                    "timestamp_eastern": first_pass,
                },
            ]
        )
        close_pairs = find_close_pairs(pings, {"t1": 0})
        assert len(close_pairs) == 1

    def test_bucket_spans_the_spring_gap(self):
        # 2027-03-14 (US spring-forward): 02:00-02:59 EST never happens (the
        # clock jumps to 03:00 EDT). Bucketing floors the absolute instant, so
        # pings on either side of the jump keep their spacing and no nonexistent
        # wall time is ever built.
        before = pd.Timestamp("2027-03-14 06:59:00", tz="UTC").tz_convert(
            EASTERN
        )  # 01:59 EST
        after = pd.Timestamp("2027-03-14 07:01:00", tz="UTC").tz_convert(
            EASTERN
        )  # 03:01 EDT
        b1, b2 = _bucket(before), _bucket(after)
        assert b2 - b1 == pd.Timedelta(minutes=2)


class TestTerminalStagingExclusion:
    """A1: vehicles parked together at a route terminal or layover are staged,
    not bunched. Pairs where BOTH vehicles are within TERMINAL_RADIUS_METERS
    of their trip's first or last stop are excluded; everything else stays."""

    def _terminals(self) -> dict[str, tuple[StopInfo | None, StopInfo | None]]:
        terminal = StopInfo(
            stop_id="term", stop_name=None, stop_lat=42.0, stop_lon=-71.0
        )
        return {"t1": (terminal, terminal), "t2": (terminal, terminal)}

    def _pings(self, lat_a: float, lat_b: float) -> pd.DataFrame:
        t = eastern_ts("2026-11-03 08:00:00")
        return pd.DataFrame(
            [
                {
                    "vehicle_id": "v1",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": lat_a,
                    "lon": -71.0,
                    "timestamp_eastern": t,
                },
                {
                    "vehicle_id": "v2",
                    "trip_id": "t2",
                    "route_id": "R1",
                    "lat": lat_b,
                    "lon": -71.0,
                    "timestamp_eastern": t,
                },
            ]
        )

    def test_pair_staged_at_terminal_is_not_flagged(self):
        # ~111 m and ~167 m from the terminal, ~56 m apart: a staged pair.
        pings = self._pings(42.001, 42.0015)
        pairs = find_close_pairs(
            pings, {"t1": 0, "t2": 0}, trip_terminals=self._terminals()
        )
        assert len(pairs) == 0

    def test_pair_close_mid_route_is_still_flagged(self):
        # Same ~56 m separation but 55 km away from the terminal.
        pings = self._pings(42.5, 42.5005)
        pairs = find_close_pairs(
            pings, {"t1": 0, "t2": 0}, trip_terminals=self._terminals()
        )
        assert len(pairs) == 1

    def test_pair_with_only_one_vehicle_at_terminal_is_flagged(self):
        # a is 200 m from the terminal (inside the radius), b is 290 m
        # (outside); they are 90 m apart, so the pair forms and must survive.
        pings = self._pings(42.0 + 200 / 111_320, 42.0 + 290 / 111_320)
        pairs = find_close_pairs(
            pings, {"t1": 0, "t2": 0}, trip_terminals=self._terminals()
        )
        assert len(pairs) == 1

    def test_unknown_trip_terminals_fail_open(self):
        pings = self._pings(42.001, 42.0015)
        pairs = find_close_pairs(
            pings, {"t1": 0, "t2": 0}, trip_terminals={"t9": (None, None)}
        )
        assert len(pairs) == 1


class TestConsecutiveTolerance:
    """M2: a single skipped poll bucket (30 s on the 15 s bucket grid -- the
    documented ~16 s jitter failure mode) must not split one continuous
    event."""

    @staticmethod
    def _pairs(buckets: list[int]) -> pd.DataFrame:
        t0 = eastern_ts("2026-11-03 08:00:00")
        return pd.DataFrame(
            [
                {
                    "route_id": "R1",
                    "direction_id": 0,
                    "vehicle_a": "v1",
                    "vehicle_b": "v2",
                    "time_bucket": t0 + pd.Timedelta(seconds=b),
                    "distance_meters": 50.0,
                }
                for b in buckets
            ]
        )

    def test_one_skipped_bucket_does_not_split_the_event(self):
        # The empty (not None) separation frame asserts "checked, none
        # observed" -- which is what unlocks the jitter tolerance.
        no_separations = pd.DataFrame(
            columns=[
                "route_id",
                "direction_id",
                "vehicle_a",
                "vehicle_b",
                "time_bucket",
            ]
        )
        events = detect_bunching_events(
            self._pairs([0, 15, 45, 60]),
            min_consecutive=2,
            separated_pairs=no_separations,
        )
        assert len(events) == 1
        assert events[0].observation_count == 4

    def test_two_skipped_buckets_split_the_event(self):
        events = detect_bunching_events(self._pairs([0, 15, 75, 90]), min_consecutive=2)
        assert len(events) == 2

    def test_observed_separation_still_splits_the_event(self):
        # close at 0,15; observed FAR apart at 30; close again at 45,60.
        # The gap is inside the tolerance but the separation is real.
        t0 = eastern_ts("2026-11-03 08:00:00")
        separated = pd.DataFrame(
            [
                {
                    "route_id": "R1",
                    "direction_id": 0,
                    "vehicle_a": "v1",
                    "vehicle_b": "v2",
                    "time_bucket": t0 + pd.Timedelta(seconds=30),
                }
            ]
        )
        events = detect_bunching_events(
            self._pairs([0, 15, 45, 60]),
            min_consecutive=2,
            separated_pairs=separated,
        )
        assert len(events) == 2

    def test_return_separated_reports_far_pairs(self):
        # The same-bucket pair at 1 km exceeds the threshold: it must appear
        # only in the separated frame, which is what tells detect_bunching_events
        # apart from a merely missing poll.
        t = eastern_ts("2026-11-03 08:00:00")
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "v1",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.5,
                    "lon": -71.0,
                    "timestamp_eastern": t,
                },
                {
                    "vehicle_id": "v2",
                    "trip_id": "t1",
                    "route_id": "R1",
                    "lat": 42.51,
                    "lon": -71.0,
                    "timestamp_eastern": t,
                },
            ]
        )
        close, far = find_close_pairs(pings, {"t1": 0}, return_separated=True)
        assert len(close) == 0
        assert len(far) == 1
