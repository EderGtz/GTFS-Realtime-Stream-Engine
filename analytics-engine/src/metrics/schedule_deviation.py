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
from typing import Optional

import pandas as pd

AGENCY_TZ = "America/New_York"


@dataclass(frozen=True)
class ScheduledStopTime:
    """One row from stop_times.txt, keyed by (trip_id, stop_sequence)."""
    trip_id: str
    stop_sequence: int
    arrival_time: Optional[str]    # raw GTFS "HH:MM:SS" text; hours may exceed 24
    departure_time: Optional[str]


@dataclass(frozen=True)
class DeviationResult:
    vehicle_id: str
    trip_id: str
    stop_sequence: int
    kind: str                      # "arrival" or "departure"
    scheduled_at: pd.Timestamp
    actual_at: pd.Timestamp
    deviation_seconds: float


def parse_gtfs_time_offset(time_str: str) -> timedelta:
    """Parse a GTFS HH:MM:SS string (hours may exceed 24) into an offset from midnight."""
    h, m, s = (int(part) for part in time_str.split(":"))
    return timedelta(hours=h, minutes=m, seconds=s)


def resolve_scheduled_datetime(actual_eastern: pd.Timestamp, gtfs_time_str: str) -> pd.Timestamp:
    """
    Anchor a GTFS time string to a real datetime by choosing whichever of the previous,
    same, or next Eastern calendar day lands closest to the actual observed time.

    Known limitation (notebook 03, Section C): assumes the vehicle isn't off-schedule by
    more than roughly half a day. Fine for MVP; would need a smarter anchor (e.g. against
    the trip's own scheduled start time) if extreme deviations ever become common.
    """
    offset = parse_gtfs_time_offset(gtfs_time_str)
    midnight = actual_eastern.normalize()

    candidates = [
        midnight + offset,
        (midnight - pd.Timedelta(days=1)) + offset,
        (midnight + pd.Timedelta(days=1)) + offset,
    ]
    return min(candidates, key=lambda c: abs((c - actual_eastern).total_seconds()))


def to_eastern(timestamp) -> pd.Timestamp:
    """Explicit conversion to the agency's service-day timezone -- never rely on
    whatever timezone a database session or system default happens to display."""
    ts = pd.Timestamp(timestamp)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return ts.tz_convert(AGENCY_TZ)


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
    return (
        stopped
        .groupby(["vehicle_id", "trip_id", "current_stop_sequence"], as_index=False)
        .first()
    )


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
        key = (row.trip_id, int(row.current_stop_sequence))
        scheduled = stop_times_lookup.get(key)
        if scheduled is None or not scheduled.arrival_time:
            continue

        actual_eastern = to_eastern(row.timestamp_eastern)
        scheduled_dt = resolve_scheduled_datetime(actual_eastern, scheduled.arrival_time)
        deviation = (actual_eastern - scheduled_dt).total_seconds()

        results.append(DeviationResult(
            vehicle_id=row.vehicle_id,
            trip_id=row.trip_id,
            stop_sequence=int(row.current_stop_sequence),
            kind="arrival",
            scheduled_at=scheduled_dt,
            actual_at=actual_eastern,
            deviation_seconds=deviation,
        ))

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
    last_before_departure = (
        stopped
        .groupby(["vehicle_id", "trip_id", "current_stop_sequence"], as_index=False)
        .last()
    )

    results: list[DeviationResult] = []
    for row in last_before_departure.itertuples():
        key = (row.trip_id, int(row.current_stop_sequence))
        scheduled = stop_times_lookup.get(key)
        if scheduled is None or not scheduled.departure_time:
            continue

        actual_eastern = to_eastern(row.timestamp_eastern)
        scheduled_dt = resolve_scheduled_datetime(actual_eastern, scheduled.departure_time)
        deviation = (actual_eastern - scheduled_dt).total_seconds()

        results.append(DeviationResult(
            vehicle_id=row.vehicle_id,
            trip_id=row.trip_id,
            stop_sequence=int(row.current_stop_sequence),
            kind="departure",
            scheduled_at=scheduled_dt,
            actual_at=actual_eastern,
            deviation_seconds=deviation,
        ))

    return results
