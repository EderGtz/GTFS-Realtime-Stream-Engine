"""
Unit tests for metrics/schedule_deviation.py.

Each test targets one specific decision made in 03_schedule_deviation.ipynb, using
fixed synthetic inputs with known expected outputs -- not live data -- per the
README's Phase 3 testing criterion.
"""

import pandas as pd
import pytest

from metrics.schedule_deviation import (
    ScheduledStopTime,
    collapse_to_first_arrival,
    compute_arrival_deviations,
    compute_departure_deviations,
    parse_gtfs_time_offset,
    resolve_scheduled_datetime,
    to_eastern,
)

EASTERN = "America/New_York"


def eastern_ts(s: str) -> pd.Timestamp:
    return pd.Timestamp(s, tz=EASTERN)


class TestParseGtfsTimeOffset:
    def test_normal_time(self):
        assert parse_gtfs_time_offset("08:15:30") == pd.Timedelta(
            hours=8, minutes=15, seconds=30
        )

    def test_past_midnight_time(self):
        # GTFS deliberately allows this -- a trip starting before midnight and
        # continuing after it (notebook 03, Section B).
        assert parse_gtfs_time_offset("25:10:00") == pd.Timedelta(hours=25, minutes=10)


class TestGtfsTimeToSeconds:
    def test_normal_time(self):
        from metrics.schedule_deviation import gtfs_time_to_seconds

        assert gtfs_time_to_seconds("08:15:30") == 8 * 3600 + 15 * 60 + 30

    def test_midnight(self):
        from metrics.schedule_deviation import gtfs_time_to_seconds

        assert gtfs_time_to_seconds("00:00:00") == 0

    def test_past_midnight(self):
        from metrics.schedule_deviation import gtfs_time_to_seconds

        assert gtfs_time_to_seconds("25:10:00") == 25 * 3600 + 10 * 60

    def test_no_seconds(self):
        from metrics.schedule_deviation import gtfs_time_to_seconds

        assert gtfs_time_to_seconds("08:05:00") == 8 * 3600 + 5 * 60


class TestResolveScheduledDatetime:
    def test_same_day_anchor(self):
        actual = eastern_ts("2026-08-18 08:20:00")
        resolved = resolve_scheduled_datetime(actual, 8 * 3600 + 15 * 60)  # 08:15:00
        assert resolved == eastern_ts("2026-08-18 08:15:00")

    def test_midnight_crossing_anchors_to_previous_day(self):
        # A ping at 01:15 on the 19th, scheduled time "25:10:00" -- must resolve to
        # 01:10 on the 19th (i.e. the PREVIOUS service day's 25:10, not literally
        # parsed against the 19th's own midnight).
        actual = eastern_ts("2026-08-19 01:15:00")
        resolved = resolve_scheduled_datetime(actual, 25 * 3600 + 10 * 60)  # 25:10:00
        assert resolved == eastern_ts("2026-08-19 01:10:00")

    def test_picks_closest_candidate_not_just_same_day(self):
        # An early-morning ping just after midnight, scheduled time is small (00:05),
        # which legitimately belongs to the CURRENT day here, not a stretch backward.
        actual = eastern_ts("2026-08-19 00:07:00")
        resolved = resolve_scheduled_datetime(actual, 5 * 60)  # 00:05:00
        assert resolved == eastern_ts("2026-08-19 00:05:00")


class TestResolveScheduledDatetimeDst:
    """DST regression tests. Scheduled times are anchored at "noon minus 12h"
    of the service day (the GTFS spec definition). The old wall-midnight
    arithmetic resolved the whole 2026-11-01 service day one hour early
    (tz-aware Timestamp + timedelta adds absolute time, not wall time), and the
    consumer's ±30-minute gate silently rejected the results -- the day
    produced near-zero metrics in production (hardening review)."""

    def test_fall_back_day_resolves_wall_time_correctly(self):
        # 15:05 UTC = 10:05 EST on the 25-hour day.
        actual = pd.Timestamp("2026-11-01 15:05", tz="UTC").tz_convert(EASTERN)
        resolved = resolve_scheduled_datetime(actual, 10 * 3600)
        assert resolved == pd.Timestamp("2026-11-01 15:00", tz="UTC")  # 10:00 EST

    def test_fall_back_day_past_midnight_time(self):
        # 25:30:00 on the 2026-11-01 service day = 01:30 EST on Nov 2.
        actual = pd.Timestamp("2026-11-02 06:35", tz="UTC").tz_convert(EASTERN)
        resolved = resolve_scheduled_datetime(actual, 25 * 3600 + 30 * 60)
        assert resolved == pd.Timestamp("2026-11-02 06:30", tz="UTC")

    def test_repeated_hour_maps_to_both_passes(self):
        # Per the spec's absolute arithmetic, the repeated wall hour is reached
        # by schedule 00:30:00 (first/EDT pass) and 01:30:00 (second/EST pass)
        # -- both anchored steadily from noon minus 12h, never re-localized.
        first = pd.Timestamp("2026-11-01 05:35", tz="UTC").tz_convert(
            EASTERN
        )  # 01:35 EDT
        second = pd.Timestamp("2026-11-01 06:35", tz="UTC").tz_convert(
            EASTERN
        )  # 01:35 EST
        assert resolve_scheduled_datetime(first, 30 * 60) == pd.Timestamp(
            "2026-11-01 05:30", tz="UTC"
        )
        assert resolve_scheduled_datetime(second, 90 * 60) == pd.Timestamp(
            "2026-11-01 06:30", tz="UTC"
        )

    def test_normal_day_behavior_unchanged(self):
        actual = eastern_ts("2026-11-03 08:20:00")
        resolved = resolve_scheduled_datetime(actual, 8 * 3600 + 15 * 60)
        assert resolved == eastern_ts("2026-11-03 08:15:00")

    def test_spring_forward_day_early_trip(self):
        # 2027-03-14 (US spring-forward) is a 23-hour day: the spec anchor
        # (noon minus 12h) lands
        # at 23:00 of the previous wall day, so pre-jump schedule strings sit
        # one wall-hour early -- "01:30:00" resolves to 00:30 EST. That is the
        # spec's absolute-arithmetic behavior on a shortened day.
        actual = pd.Timestamp("2027-03-14 05:35", tz="UTC").tz_convert(
            EASTERN
        )  # 00:35 EST
        resolved = resolve_scheduled_datetime(actual, 90 * 60)
        assert resolved == pd.Timestamp("2027-03-14 05:30", tz="UTC")

    def test_spring_forward_trip_across_the_gap(self):
        # Observed just before the jump, scheduled just after it: the seam is
        # continuous in absolute time and no nonexistent wall time is built.
        actual = pd.Timestamp("2027-03-14 06:55", tz="UTC").tz_convert(
            EASTERN
        )  # 01:55 EST
        resolved = resolve_scheduled_datetime(actual, 3 * 3600 + 15 * 60)
        assert resolved == pd.Timestamp("2027-03-14 07:15", tz="UTC")  # 03:15 EDT

    def test_spring_forward_past_midnight_time(self):
        # 25:15:00 on the 2027-03-14 service day = 01:15 EDT on Mar 15.
        actual = pd.Timestamp("2027-03-15 05:20", tz="UTC").tz_convert(
            EASTERN
        )  # 01:20 EDT
        resolved = resolve_scheduled_datetime(actual, 25 * 3600 + 15 * 60)
        assert resolved == pd.Timestamp("2027-03-15 05:15", tz="UTC")


class TestToEastern:
    def test_converts_naive_utc_to_eastern(self):
        result = to_eastern("2026-08-18T17:19:15.000Z")
        assert result.tzinfo is not None
        assert str(result.tz) == EASTERN

    def test_preserves_absolute_instant(self):
        # Regardless of what timezone a value displays as, the underlying instant
        # must round-trip correctly (notebook 03, Section A).
        utc_val = pd.Timestamp("2026-08-18 17:19:15", tz="UTC")
        eastern_val = to_eastern(utc_val)
        assert eastern_val.tz_convert("UTC") == utc_val


@pytest.fixture
def dwell_pings() -> pd.DataFrame:
    """Three STOPPED_AT pings for the same arrival, 5 and 15 minutes apart --
    simulating a vehicle sitting through a long dwell/layover."""
    return pd.DataFrame(
        [
            {
                "vehicle_id": "v1",
                "trip_id": "t1",
                "current_stop_sequence": 5,
                "current_status": "STOPPED_AT",
                "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
            },
            {
                "vehicle_id": "v1",
                "trip_id": "t1",
                "current_stop_sequence": 5,
                "current_status": "STOPPED_AT",
                "timestamp_eastern": eastern_ts("2026-08-18 10:05:00"),
            },
            {
                "vehicle_id": "v1",
                "trip_id": "t1",
                "current_stop_sequence": 5,
                "current_status": "STOPPED_AT",
                "timestamp_eastern": eastern_ts("2026-08-18 10:20:00"),
            },
        ]
    )


class TestCollapseToFirstArrival:
    def test_collapses_repeated_dwell_pings_to_one_row(self, dwell_pings):
        collapsed = collapse_to_first_arrival(dwell_pings)
        assert len(collapsed) == 1

    def test_keeps_the_earliest_ping_not_the_latest(self, dwell_pings):
        # This is the crux of notebook 03 Section E's finding: keeping a LATER ping
        # would inflate the apparent lateness by however long the dwell lasted.
        collapsed = collapse_to_first_arrival(dwell_pings)
        assert collapsed.iloc[0]["timestamp_eastern"] == eastern_ts(
            "2026-08-18 10:00:00"
        )

    def test_ignores_non_stopped_at_pings(self):
        pings = pd.DataFrame(
            [
                {
                    "vehicle_id": "v1",
                    "trip_id": "t1",
                    "current_stop_sequence": 5,
                    "current_status": "IN_TRANSIT_TO",
                    "timestamp_eastern": eastern_ts("2026-08-18 10:00:00"),
                },
            ]
        )
        collapsed = collapse_to_first_arrival(pings)
        assert len(collapsed) == 0

    def test_keeps_distinct_stops_separate(self, dwell_pings):
        extra = pd.concat(
            [
                dwell_pings,
                pd.DataFrame(
                    [
                        {
                            "vehicle_id": "v1",
                            "trip_id": "t1",
                            "current_stop_sequence": 6,
                            "current_status": "STOPPED_AT",
                            "timestamp_eastern": eastern_ts("2026-08-18 10:30:00"),
                        }
                    ]
                ),
            ],
            ignore_index=True,
        )
        collapsed = collapse_to_first_arrival(extra)
        assert len(collapsed) == 2


class TestComputeArrivalDeviations:
    def test_computes_correct_deviation_from_first_arrival(self, dwell_pings):
        lookup = {
            ("t1", 5): ScheduledStopTime(
                trip_id="t1",
                stop_sequence=5,
                arrival_time=10 * 3600 + 2 * 60,
                departure_time=10 * 3600 + 15 * 60,
            ),
        }
        results = compute_arrival_deviations(dwell_pings, lookup)
        assert len(results) == 1
        assert results[0].kind == "arrival"
        # Arrived at 10:00, scheduled 10:02 -> 120 seconds early (negative).
        assert results[0].deviation_seconds == pytest.approx(-120.0)

    def test_skips_stops_with_no_arrival_time(self, dwell_pings):
        # Trip-origin stops commonly have only a departure_time -- must not be
        # forced through as a fake "arrival" deviation (notebook 03, Section E).
        lookup = {
            ("t1", 5): ScheduledStopTime(
                trip_id="t1",
                stop_sequence=5,
                arrival_time=None,
                departure_time=10 * 3600 + 15 * 60,
            ),
        }
        results = compute_arrival_deviations(dwell_pings, lookup)
        assert results == []

    def test_skips_stops_missing_from_the_static_schedule(self, dwell_pings):
        # Simulates a Shuttle-Generic*/no-schedule trip -- notebook 02 confirmed
        # these have no stop_times.txt entry to match against.
        results = compute_arrival_deviations(dwell_pings, stop_times_lookup={})
        assert results == []


class TestComputeDepartureDeviations:
    def test_uses_last_ping_not_first(self, dwell_pings):
        lookup = {
            ("t1", 5): ScheduledStopTime(
                trip_id="t1",
                stop_sequence=5,
                arrival_time=10 * 3600 + 2 * 60,
                departure_time=10 * 3600 + 15 * 60,
            ),
        }
        results = compute_departure_deviations(dwell_pings, lookup)
        assert len(results) == 1
        assert results[0].kind == "departure"
        # Last STOPPED_AT ping at 10:20, scheduled departure 10:15 -> 300s late.
        assert results[0].deviation_seconds == pytest.approx(300.0)

    def test_skips_stops_with_no_departure_time(self, dwell_pings):
        lookup = {
            ("t1", 5): ScheduledStopTime(
                trip_id="t1",
                stop_sequence=5,
                arrival_time=10 * 3600 + 2 * 60,
                departure_time=None,
            ),
        }
        results = compute_departure_deviations(dwell_pings, lookup)
        assert results == []
