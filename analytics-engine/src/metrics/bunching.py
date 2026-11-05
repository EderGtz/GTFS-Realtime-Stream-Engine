"""
Bunching detection.

Design decisions carried over from 04_bunching.ipynb:

- Two vehicles are only compared if they share route_id AND direction_id -- same-route,
  opposite-direction vehicles passing each other are explicitly excluded (notebook 04,
  Section B). direction_id is resolved via an in-memory trips.txt lookup supplied by the
  GTFS-static loader, not a per-message file read.
- Distance uses the same equirectangular meters approximation validated in notebooks
  01/02/04 (111,320 m/degree, cos(lat) longitude correction).
- A single close ping does not count as bunching -- proximity must persist for
  MIN_CONSECUTIVE_OBSERVATIONS consecutive poll cycles (notebook 04, Section C).
- DISTANCE_THRESHOLD_METERS=100 / MIN_CONSECUTIVE_OBSERVATIONS=2 were chosen via a
  sensitivity sweep that showed a smooth gradient with no sharp cliff at this
  resolution -- the values are operationally anchored (~5-8 bus-lengths) rather than
  derived from a single "optimal" statistic, since none existed in the sweep
  (notebook 04, Section C).

Known limitation, documented but not fixed: bucketing timestamps to a fixed poll-interval
grid can split one real, continuous bunching event into two shorter ones if two vehicles'
actual poll times straddle a bucket boundary, since real update cadence has jitter around
the nominal interval (notebook 01 found a median of ~16s, not exactly 15s).
"""

from __future__ import annotations

from dataclasses import dataclass
from math import cos, radians, sqrt

import numpy as np
import pandas as pd

from gtfs_static.loader import StopInfo

METERS_PER_DEGREE = 111_320
POLL_INTERVAL_SECONDS = 15  # matches BASE_INTERVAL_MS in poller.ts
DISTANCE_THRESHOLD_METERS = 100  # notebook 04, Section C
MIN_CONSECUTIVE_OBSERVATIONS = 2  # notebook 04, Section C
TERMINAL_RADIUS_METERS = 250  # staging/layover proximity, see find_close_pairs
CONSECUTIVE_TOLERANCE_FACTOR = 2  # one skipped poll bucket, see detect_bunching_events


@dataclass(frozen=True)
class BunchingEvent:
    """Period where two vehicles remain unusually close for consecutive observations.

    `start_time` and `end_time` define the event window, and `min_distance_meters`
    records the closest observed distance between the vehicles during that window.
    """

    route_id: str
    direction_id: int
    vehicle_a: str
    vehicle_b: str
    start_time: pd.Timestamp
    end_time: pd.Timestamp
    observation_count: int
    min_distance_meters: float


def displacement_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Equirectangular approximation, validated in notebooks 01/02/04 at this scale."""
    mid_lat_rad = radians((lat1 + lat2) / 2)
    dx = (lon2 - lon1) * METERS_PER_DEGREE * cos(mid_lat_rad)
    dy = (lat2 - lat1) * METERS_PER_DEGREE
    return sqrt(dx**2 + dy**2)


def _bucket(timestamp: pd.Timestamp) -> pd.Timestamp:
    if timestamp.tzinfo is None:
        return timestamp.floor(f"{POLL_INTERVAL_SECONDS}s")
    return (
        timestamp.tz_convert("UTC")
        .floor(f"{POLL_INTERVAL_SECONDS}s")
        .tz_convert(timestamp.tzinfo)
    )


def _near_terminal(
    lat: float,
    lon: float,
    terminals: tuple[StopInfo | None, StopInfo | None] | None,
) -> bool:
    if not terminals:
        return False
    for stop in terminals:
        if (
            stop is not None
            and stop.stop_lat is not None
            and stop.stop_lon is not None
            and displacement_meters(lat, lon, stop.stop_lat, stop.stop_lon)
            <= TERMINAL_RADIUS_METERS
        ):
            return True
    return False


def find_close_pairs(
    pings: pd.DataFrame,
    direction_lookup: dict[str, int],
    distance_threshold_m: float = DISTANCE_THRESHOLD_METERS,
    trip_terminals: dict[str, tuple[StopInfo | None, StopInfo | None]] | None = None,
    return_separated: bool = False,
) -> pd.DataFrame | tuple[pd.DataFrame, pd.DataFrame]:
    """
    Return every same-route, same-direction, same-poll-bucket vehicle pair within
    distance_threshold_m of each other, at a single point in time.

    `pings` must have vehicle_id, trip_id, route_id, timestamp_eastern, lat, lon.
    `direction_lookup` maps trip_id -> direction_id, sourced from an in-memory
    GTFS-static load (per the README's Phase 3 refresh design).

    When `trip_terminals` is provided (trip_id -> (first stop, last stop) from
    the GTFS-static load), pairs where BOTH vehicles are within
    TERMINAL_RADIUS_METERS of their trip's first or last stop are excluded:
    vehicles staged together at a terminal or layover are not bunched.
    Pairs whose trip terminal data is unknown are kept -- fail open rather
    than suppress real events. A near-zero-speed refinement is possible but
    deliberately not done here; see the hardening plan.

    With return_separated=True, also returns the candidate pairs that were
    observed far apart in a shared bucket (distance above the threshold).
    detect_bunching_events needs those to tell "the pair drifted apart" (a
    real break in an event) from "a poll was simply missing" (jitter).
    """
    df = pings.copy()
    df["direction_id"] = df["trip_id"].map(direction_lookup)
    df = df.dropna(subset=["direction_id", "lat", "lon"])
    df["time_bucket"] = df["timestamp_eastern"].apply(_bucket)
    df["near_terminal"] = [
        _near_terminal(
            lat, lon, trip_terminals.get(str(trip_id)) if trip_terminals else None
        )
        for lat, lon, trip_id in zip(df["lat"], df["lon"], df["trip_id"])
    ]

    # A vehicle can produce two real pings that floor into the same bucket due to
    # normal poll jitter. Without this, it can self-pair against itself, producing
    # a meaningless zero-distance pair (found via notebook 04's cluster investigation:
    # showed up as impossible size-1 "clusters" after union-find).
    df = df.sort_values("timestamp_eastern").drop_duplicates(
        subset=["vehicle_id", "time_bucket"], keep="first"
    )

    # Generate candidate pairs that share the same route, direction, and time bucket.
    #
    # A self-merge materializes the candidate combinations in a vectorized form.
    # This is intentionally preferred over nested Python loops because, at the
    # expected scale, each (route, direction, time_bucket) group contains relatively
    # few vehicles. The additional intermediate memory from the self-merge is therefore
    # considered an acceptable trade-off for faster vectorized distance calculations.
    pairs = df.merge(
        df, on=["time_bucket", "route_id", "direction_id"], suffixes=("_a", "_b")
    )

    # Keep each unordered vehicle pair exactly once, using a canonical ordering.
    pairs = pairs[pairs["vehicle_id_a"] < pairs["vehicle_id_b"]].copy()

    # Vectorized equivalent of displacement_meters() for all candidate pairs.
    # Keeping this calculation vectorized avoids a row-wise apply(), which would
    # introduce Python-level function calls, reducing the performance
    # of the self-merge approach.
    mid_lat_rad = np.radians((pairs["lat_a"] + pairs["lat_b"]) / 2)
    dx = (pairs["lon_b"] - pairs["lon_a"]) * METERS_PER_DEGREE * np.cos(mid_lat_rad)
    dy = (pairs["lat_b"] - pairs["lat_a"]) * METERS_PER_DEGREE
    pairs["distance_meters"] = np.sqrt(dx**2 + dy**2)

    close_pairs = pairs[pairs["distance_meters"] <= distance_threshold_m]
    far_pairs = pairs[pairs["distance_meters"] > distance_threshold_m]

    # Both vehicles parked at a terminal/layover => staged, not bunched. One
    # vehicle at a terminal while another closes in is a real event and stays.
    close_pairs = close_pairs[
        ~(close_pairs["near_terminal_a"] & close_pairs["near_terminal_b"])
    ]

    rename_map = {"vehicle_id_a": "vehicle_a", "vehicle_id_b": "vehicle_b"}
    close_pairs = close_pairs.rename(columns=rename_map)
    if return_separated:
        return close_pairs, far_pairs.rename(columns=rename_map)
    return close_pairs


def _separated_index(
    separated_pairs: pd.DataFrame | None,
    group_cols: list[str],
) -> dict[tuple, list[pd.Timestamp]]:
    """Map pair key -> sorted time buckets where that pair was observed far
    apart. Built once per call so the run loop stays O(rows), not
    O(groups x rows)."""
    if separated_pairs is None or separated_pairs.empty:
        return {}
    index: dict[tuple, list[pd.Timestamp]] = {}
    for key, group in separated_pairs.groupby(group_cols):
        index[key if isinstance(key, tuple) else (key,)] = sorted(group["time_bucket"])
    return index


def detect_bunching_events(
    close_pairs: pd.DataFrame,
    min_consecutive: int = MIN_CONSECUTIVE_OBSERVATIONS,
    separated_pairs: pd.DataFrame | None = None,
) -> list[BunchingEvent]:
    """
    Collapse consecutive-bucket close-pair observations into discrete bunching events,
    keeping only runs that meet the persistence requirement (notebook 04, Section B/C).

    Consecutiveness tolerates one skipped poll bucket (M2: cadence jitter
    occasionally misses one), but `separated_pairs` rows -- the pair observed
    far apart in a shared bucket, from find_close_pairs(return_separated=True)
    -- mark a real break and still split the run. Without that frame the two
    situations are indistinguishable in close_pairs alone.
    """
    if close_pairs.empty:
        return []

    events: list[BunchingEvent] = []
    close_pairs = close_pairs.sort_values(
        ["route_id", "direction_id", "vehicle_a", "vehicle_b", "time_bucket"]
    )

    group_cols = ["route_id", "direction_id", "vehicle_a", "vehicle_b"]
    sep_index = _separated_index(separated_pairs, group_cols)
    for key, group in close_pairs.groupby(group_cols):
        group = group.reset_index(drop=True)
        time_buckets = pd.DatetimeIndex(group["time_bucket"])
        run_start = 0
        sep_buckets = sep_index.get(key if isinstance(key, tuple) else (key,), [])

        for i in range(1, len(group) + 1):
            if i >= len(group):
                is_consecutive = False
            else:
                gap = time_buckets[i] - time_buckets[i - 1]
                if gap == pd.Timedelta(seconds=POLL_INTERVAL_SECONDS):
                    is_consecutive = True
                elif separated_pairs is None:
                    # No separation information: conservative, any gap is a break
                    is_consecutive = False
                else:
                    # Tolerate one skipped poll bucket between observations:
                    # gaps are quantized to the 15 s bucket grid, so the
                    # review's suggested 1.5x would be a silent no-op, while
                    # real cadence jitter (~16 s median against the nominal
                    # 15 s) occasionally misses a bucket. An observed
                    # separation in the gap is a real break and never merges.
                    tolerated = gap <= pd.Timedelta(
                        seconds=POLL_INTERVAL_SECONDS * CONSECUTIVE_TOLERANCE_FACTOR
                    )
                    broken = any(
                        time_buckets[i - 1] < b < time_buckets[i] for b in sep_buckets
                    )
                    is_consecutive = tolerated and not broken

            if not is_consecutive:
                run = group.iloc[run_start:i]

                if len(run) >= min_consecutive:
                    events.append(
                        BunchingEvent(
                            route_id=run.iloc[0]["route_id"],
                            direction_id=int(run.iloc[0]["direction_id"]),
                            vehicle_a=run.iloc[0]["vehicle_a"],
                            vehicle_b=run.iloc[0]["vehicle_b"],
                            start_time=run.iloc[0]["time_bucket"],
                            end_time=run.iloc[-1]["time_bucket"],
                            observation_count=len(run),
                            min_distance_meters=float(run["distance_meters"].min()),
                        )
                    )
                run_start = i

    return events
