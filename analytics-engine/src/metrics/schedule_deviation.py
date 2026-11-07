"""
Schedule deviation computation.

Design decisions carried over from 03_schedule_deviation.ipynb (see notebook for the
empirical justification of each):

- All datetime comparisons happen in the agency's own service-day timezone
  (America/New_York), converted explicitly -- never relying on a database or system
  default display timezone (notebook 03, Section A: demonstrated to be a real, not
  theoretical, risk -- the extreme-outlier count only dropped to 0% once this
  conversion was made explicit after a DuckDB round-trip).
- GTFS times >= 24:00:00 (past-midnight trips) are resolved via nearest-anchor
  matching across the previous/same/next Eastern calendar day (notebook 03, Section C).
- Trips with no stop_id (Shuttle-Generic*/no-schedule replacement service) are excluded
  entirely -- notebook 02 confirmed these have no stop_times.txt entry to match against
  under any strategy (notebook 02, Section C; notebook 01, Section F).
- Deviation is computed once per genuine arrival event, not once per raw ping: many
  consecutive STOPPED_AT pings during a single dwell/layover must collapse to one
  "first observed arrival" sample, or a long layover inflates the apparent lateness
  of an otherwise on-time vehicle (notebook 03, Section E).
- arrival_time and departure_time are NOT blended via a single fallback field. They
  answer different operational questions (did it arrive on time vs. did it leave on
  time), and blending them let legitimate scheduled dwell at origin/recovery-point
  stops masquerade as lateness (notebook 03, Section E follow-up).

Open item, not yet validated against real data: compute_departure_deviations() uses
"last STOPPED_AT ping before transitioning away" as a proxy for the departure moment.
Unlike arrival-collapsing, this specific technique was never checked in the notebook --
treat it as a reasonable extension pending its own empirical validation, not an
established decision.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import cast

import pandas as pd

AGENCY_TZ = "America/New_York"


@dataclass(frozen=True, slots=True)
class ScheduledStopTime:
    """One row from stop_times.txt, keyed by (trip_id, stop_sequence).

    Times are stored as pre-parsed integer seconds-of-day (hours may exceed 24
    for past-midnight trips), not raw "HH:MM:SS" strings. Strings are the
    heaviest per-row value (~50+ bytes of unique text vs 28 bytes for an int)
    and schedule_deviation.py re-parses them anyway.

    slots=True eliminates the per-instance __dict__ (~100+ bytes/row saved),
    which matters with ~1M+ instances resident in stop_times_lookup.
    """

    trip_id: str
    stop_sequence: int
    arrival_time: int | None  # seconds since midnight; None = no arrival scheduled
    departure_time: int | None  # seconds since midnight; None = no departure scheduled
    stop_id: str | None = None  # needed for location enrichment (2dsphere index)


@dataclass(frozen=True)
class DeviationResult:
    """
    Schedule deviation for a single observed arrival or departure event.
    `deviation_seconds` is positive when the vehicle is late and negative when early.
    """

    vehicle_id: str
    trip_id: str
    stop_sequence: int
    kind: str  # "arrival" or "departure"
    scheduled_at: pd.Timestamp
    actual_at: pd.Timestamp
    deviation_seconds: float
    location: dict | None = (
        None  # GeoJSON Point {"type": "Point", "coordinates": [lon, lat]} for 2dsphere indexing
    )
    route_id: str | None = None
    route_long_name: str | None = None


def parse_gtfs_time_offset(time_str: str) -> timedelta:
    """Parse a GTFS HH:MM:SS string (hours may exceed 24) into an offset from midnight."""
    h, m, s = (int(part) for part in time_str.split(":"))
    return timedelta(hours=h, minutes=m, seconds=s)


def gtfs_time_to_seconds(time_str: str) -> int:
    """Parse a GTFS HH:MM:SS string (hours may exceed 24) into integer seconds-of-day.

    Used by the loader to pre-parse times before storing them in ScheduledStopTime,
    so the resident lookup structures hold compact ints instead of unique strings.
    """
    h, m, s = (int(part) for part in time_str.split(":"))
    return h * 3600 + m * 60 + s


def resolve_scheduled_datetime(
    actual_eastern: pd.Timestamp, scheduled_seconds: int
) -> pd.Timestamp:
    """
    Anchor a pre-parsed GTFS time (integer seconds-of-day) to a real datetime by
    choosing whichever of the previous, same, or next service day lands closest
    to the actual observed time.

    The anchor is "noon minus 12 hours" of the service day, exactly as the GTFS
    spec defines schedule times -- NOT plain wall-clock midnight. On a DST
    transition day (e.g. America/New_York on 2026-11-01, a 25-hour day) the old
    "midnight + timedelta" arithmetic resolved every scheduled time one hour
    early (tz-aware Timestamp + timedelta adds absolute time, not wall time),
    and the consumer's ±30-minute gate then silently rejected the results -- the
    whole service day produced near-zero output. Anchoring at noon (never
    ambiguous) minus 12 absolute hours is correct on every day and is identical
    to the old arithmetic on normal 24-hour days.

    Known limitation (notebook 03, Section C): assumes the vehicle isn't off-schedule by
    more than roughly half a day. Fine for MVP; would need a smarter anchor (e.g. against
    the trip's own scheduled start time) if extreme deviations ever become common.
    """
    offset = timedelta(seconds=scheduled_seconds)
    service_date = actual_eastern.date()

    candidates = []
    for day_delta in (-1, 0, 1):
        day = service_date + timedelta(days=day_delta)
        # Noon is unambiguous in every timezone on every day, which is why the
        # GTFS spec anchors here instead of at midnight.
        noon = pd.Timestamp(
            year=day.year, month=day.month, day=day.day, hour=12
        ).tz_localize(AGENCY_TZ)
        anchor = noon - pd.Timedelta(hours=12)
        candidates.append(anchor + offset)
    return min(candidates, key=lambda c: abs((c - actual_eastern).total_seconds()))


def to_eastern(timestamp) -> pd.Timestamp:
    """Explicit conversion to the agency's service-day timezone -- never rely on
    whatever timezone a database session or system default happens to display."""
    ts = pd.Timestamp(timestamp)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return ts.tz_convert(AGENCY_TZ)


@dataclass(frozen=True)
class MatchingStats:
    """
    per-window counter of how the window's raw pings matched against the loaded schedule

    Before this existed, pings that could never produce a deviation (missing
    fields, or a trip_id the active-service filter doesn't know) were dropped
    silently -- which produced a problem on Nov 1-2 2026 :
    the raw feed kept flowing while the matching stage dropped nearly everything.

    Categories (mutually exclusive, so the sum of them equals total_pings):

    - matched_pings:        (trip_id, current_stop_sequence) found in the lookup
    - missing_field_pings:  trip_id or current_stop_sequence absent/unparseable
    - unmatched_pings:      both fields present but the key is not in the lookup
                            (unknown trip -- e.g. a stale active-service filter
                            -- or an off-schedule stop sequence)
    - gate_dropped_events:  matched arrival events later rejected by the
                            consumer's ±30-min deviation gate. NOT part of
                            total_pings (events, not pings) and deliberately not
                            counted against matched_ratio: a ghost-shift outlier
                            is a matching-quality signal of its own, and the
                            deviation-volume alert covers its aggregate effect.
    """

    total_pings: int
    matched_pings: int
    missing_field_pings: int
    unmatched_pings: int
    gate_dropped_events: int = 0

    @property
    def matched_ratio(self) -> float | None:
        """matched_pings / total_pings, or None for an empty window (0/0 is not
        a ratio -- an empty window means 'no data', which is the heartbeat's
        signal to report, not the matcher's)."""
        if self.total_pings == 0:
            return None
        return self.matched_pings / self.total_pings

    def __add__(self, other: MatchingStats) -> MatchingStats:
        """Component-wise sum, used for cumulative totals across windows."""
        return MatchingStats(
            total_pings=self.total_pings + other.total_pings,
            matched_pings=self.matched_pings + other.matched_pings,
            missing_field_pings=self.missing_field_pings + other.missing_field_pings,
            unmatched_pings=self.unmatched_pings + other.unmatched_pings,
            gate_dropped_events=self.gate_dropped_events + other.gate_dropped_events,
        )


def compute_matching_stats(
    pings: pd.DataFrame,
    stop_times_lookup: dict[tuple[str, int], ScheduledStopTime],
) -> MatchingStats:
    """
    Count how the window's raw pings match against the schedule lookup.

    Runs on the FULL window frame (before the null-stop_id scoping and the
    STOPPED_AT collapsing), because the counter's question is "is live traffic
    matching the loaded schedule at all?" -- scoping first would hide exactly
    the population the Nov 1-2 incident lost. A ping matches when its
    (trip_id, current_stop_sequence) key exists in stop_times_lookup, which is
    the same key compute_arrival_deviations() looks up.

    Pure and defensive by design: a malformed frame (missing columns, null
    fields) increments the missing-field counter instead of raising so the
    counter must never be the thing that breaks a window.
    """
    total = len(pings)
    if total == 0:
        return MatchingStats(0, 0, 0, 0)

    trip_ids = (
        pings["trip_id"]
        if "trip_id" in pings.columns
        else pd.Series([None] * total, index=pings.index)
    )
    sequences = (
        pings["current_stop_sequence"]
        if "current_stop_sequence" in pings.columns
        else pd.Series([None] * total, index=pings.index)
    )

    matched = 0
    missing = 0
    unmatched = 0
    for trip, seq in zip(trip_ids, sequences):
        if trip is None or seq is None or pd.isna(trip) or pd.isna(seq):
            missing += 1
            continue
        trip_id = str(trip)
        if not trip_id:
            missing += 1
            continue
        try:
            key = (trip_id, int(seq))
        except (TypeError, ValueError):
            missing += 1
            continue
        if key in stop_times_lookup:
            matched += 1
        else:
            unmatched += 1

    return MatchingStats(
        total_pings=total,
        matched_pings=matched,
        missing_field_pings=missing,
        unmatched_pings=unmatched,
    )


def collapse_to_first_arrival(pings: pd.DataFrame) -> pd.DataFrame:
    """
    Collapse repeated STOPPED_AT pings for the same (vehicle_id, trip_id, stop_sequence)
    into a single row -- the earliest observed timestamp -- before computing deviation.

    Without this, a vehicle sitting through a long dwell/layover generates many samples
    of the SAME arrival event, each showing increasing "lateness" purely as a function
    of how long it waited (notebook 03, Section E).
    """
    stopped = pings[pings["current_status"] == "STOPPED_AT"].copy()
    stopped = stopped.sort_values("timestamp_eastern")
    return stopped.groupby(
        ["vehicle_id", "trip_id", "current_stop_sequence"], as_index=False
    ).first()


def compute_arrival_deviations(
    pings: pd.DataFrame,
    stop_times_lookup: dict[tuple[str, int], ScheduledStopTime],
) -> list[DeviationResult]:
    """
    Compute arrival-time deviation for each genuine (collapsed) arrival event.

    `pings` must already:
      - have `timestamp_eastern` populated (America/New_York, tz-aware)
      - exclude rows with a null stop_id (Shuttle-Generic*/no-schedule trips --
        see notebook 02, Section C)

    Only rows whose matched stop_times entry has a real `arrival_time` are scored here.
    Trip-origin stops typically have none (only departure_time) and are intentionally
    left to compute_departure_deviations() instead of being forced through a fallback
    field that would misrepresent scheduled dwell as lateness.
    """
    first_arrivals = collapse_to_first_arrival(pings)
    results: list[DeviationResult] = []

    for row in first_arrivals.itertuples():
        vehicle_id = str(row.vehicle_id)
        trip_id = str(row.trip_id)
        stop_sequence = cast(int, row.current_stop_sequence)

        key = (trip_id, stop_sequence)
        scheduled = stop_times_lookup.get(key)
        if scheduled is None or scheduled.arrival_time is None:
            continue

        actual_eastern = to_eastern(row.timestamp_eastern)
        scheduled_dt = resolve_scheduled_datetime(
            actual_eastern, scheduled.arrival_time
        )
        deviation = (actual_eastern - scheduled_dt).total_seconds()

        results.append(
            DeviationResult(
                vehicle_id=vehicle_id,
                trip_id=trip_id,
                stop_sequence=int(stop_sequence),
                kind="arrival",
                scheduled_at=scheduled_dt,
                actual_at=actual_eastern,
                deviation_seconds=deviation,
            )
        )

    return results


def compute_departure_deviations(
    pings: pd.DataFrame,
    stop_times_lookup: dict[tuple[str, int], ScheduledStopTime],
) -> list[DeviationResult]:
    """
    Compute departure-time deviation using the LAST STOPPED_AT ping observed before a
    vehicle transitions away from a stop, as a proxy for the actual departure moment.

    NOTE: unlike arrival-collapsing, this specific technique was NOT validated against
    real data in 03_schedule_deviation.ipynb. Treat as a reasonable engineering
    extension pending its own empirical check, not a confirmed decision.
    """
    stopped = pings[pings["current_status"] == "STOPPED_AT"].copy()
    stopped = stopped.sort_values("timestamp_eastern")

    last_before_departure = stopped.groupby(
        ["vehicle_id", "trip_id", "current_stop_sequence"], as_index=False
    ).last()

    results: list[DeviationResult] = []

    for row in last_before_departure.itertuples():
        vehicle_id = str(row.vehicle_id)
        trip_id = str(row.trip_id)
        stop_sequence = cast(int, row.current_stop_sequence)

        key = (trip_id, stop_sequence)
        scheduled = stop_times_lookup.get(key)

        if scheduled is None or scheduled.departure_time is None:
            continue

        actual_eastern = to_eastern(row.timestamp_eastern)
        scheduled_dt = resolve_scheduled_datetime(
            actual_eastern, scheduled.departure_time
        )
        deviation = (actual_eastern - scheduled_dt).total_seconds()

        results.append(
            DeviationResult(
                vehicle_id=vehicle_id,
                trip_id=trip_id,
                stop_sequence=stop_sequence,
                kind="departure",
                scheduled_at=scheduled_dt,
                actual_at=actual_eastern,
                deviation_seconds=deviation,
            )
        )

    return results
