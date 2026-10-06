"""
GTFS-static loader.

Loads stops.txt, trips.txt, and stop_times.txt into memory once, and builds the two
lookup structures the metrics modules already depend on:

- direction_lookup   (bunching.py):           trip_id -> direction_id
- stop_times_lookup  (schedule_deviation.py): (trip_id, stop_sequence) -> ScheduledStopTime

This module implements the periodic refresh, exposing the check itself
(has_changed()) and the reload (load()). Scheduling the periodic call is main.py's
job, keeping this module directly testable without a background thread/timer.

Known GTFS quirks already discovered elsewhere in this project, handled here too:
- trip_id must be read as a string, never inferred as numeric; MBTA issues
  alphanumeric trip_ids for real-time-added/replacement service (e.g. "ADDED-*",
  "BL-*"), confirmed via notebook 04's direction-coverage investigation. Letting
  pandas infer a numeric dtype would silently corrupt or drop these.
- arrival_time/departure_time are kept as raw "HH:MM:SS" strings, untouched. GTFS
  deliberately allows values >= 24:00:00 for trips spanning midnight, and parsing
  that correctly is schedule_deviation.py's job (resolve_scheduled_datetime), not
  this loader's.
"""

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pandas as pd

from metrics.schedule_deviation import ScheduledStopTime, gtfs_time_to_seconds
from utils.logger import get_logger

_REQUIRED_FILES = (
    "stops.txt", 
    "trips.txt", 
    "stop_times.txt", 
    "routes.txt"
    )
_OPTIONAL_VERSION_FILE = "feed_info.txt"

# analytics-engine/src/gtfs_static/loader.py. parents[2] == analytics-engine/
_DEFAULT_GTFS_DIR = Path(__file__).resolve().parents[2] / "data" / "MBTA_GTFS"

_REQUIRED_COLUMNS = {
    "trips.txt": {"trip_id", "direction_id"},
    "stop_times.txt": {
        "trip_id",
        "stop_sequence",
        "arrival_time",
        "departure_time",
    },
    "stops.txt": {"stop_id"},
    "routes.txt": {"route_id", "route_long_name"},
}

logger = get_logger(__name__)

@dataclass(frozen=True)
class StopInfo:
    """One row from stops.txt, keyed by stop_id. Kept separate from
    ScheduledStopTime since it describes a physical location, not a scheduled event."""

    stop_id: str
    stop_name: str | None
    stop_lat: float | None
    stop_lon: float | None


class GtfsStaticData:
    """
    Holds one loaded snapshot of GTFS-static data and the lookups derived from it.

    Usage:
        static_data = GtfsStaticData(gtfs_dir)
        static_data.load()
        ...
        if static_data.has_changed():
            static_data.load()
    """

    def __init__(self, gtfs_dir: Path | str = _DEFAULT_GTFS_DIR):
        self.gtfs_dir = Path(gtfs_dir)

        self.direction_lookup: dict[str, int] = {}
        self.stop_times_lookup: dict[tuple[str, int], ScheduledStopTime] = {}
        self.stops_lookup: dict[str, StopInfo] = {}
        self.routes_lookup: dict[str, str | None] = {}
        self.trip_route_lookup: dict[str, str] = {}

        self._current_version: str | None = None

    def load(self) -> None:
        """
        Read all three required files fresh and rebuild every lookup. 
        
        Raises:
            FileNotFoundError: If a required GTFS file is missing.
            ValueError: If a required file is missing one or more required columns.
        """
        logger.info(f"Loading GTFS static data from {self.gtfs_dir}...")
        self._validate_files_exist()

        trips_df = pd.read_csv(
            self.gtfs_dir / "trips.txt", 
            dtype={"trip_id": str, "route_id": str, "trip_short_name": str},
        )
        stop_times_df = pd.read_csv(
            self.gtfs_dir / "stop_times.txt", 
            dtype={"trip_id": str, "stop_id": str, "stop_headsign": str},
        )
        stops_df = pd.read_csv(
            self.gtfs_dir / "stops.txt", 
            dtype={"stop_id": str},
        )
        routes_df = pd.read_csv(
            self.gtfs_dir / "routes.txt",
            dtype={"route_id": str},
        )

        self._validate_columns("trips.txt", trips_df)
        self._validate_columns("stop_times.txt", stop_times_df)
        self._validate_columns("stops.txt", stops_df)
        self._validate_columns("routes.txt", routes_df)

        # Filter to active service days before building lookups.
        # Only trips whose service_id is active today (± 1 day) can ever match live pings.
        # Skipped when trips.txt has no service_id column or no calendar data.
        if "service_id" in trips_df.columns:
            active_service_ids = self._build_active_service_ids()
            if active_service_ids is not None:
                original_trips = len(trips_df)
                trips_df = trips_df[trips_df["service_id"].isin(active_service_ids)].copy()
                filtered_trip_ids = set(trips_df["trip_id"].astype(str))
                original_st = len(stop_times_df)
                stop_times_df = stop_times_df[
                    stop_times_df["trip_id"].astype(str).isin(filtered_trip_ids)
                ].copy()
                logger.info(
                    "Service-day filter: %d -> %d trips, %d -> %d stop_times "
                    "(%d active service_ids)",
                    original_trips, len(trips_df),
                    original_st, len(stop_times_df),
                    len(active_service_ids),
                )

        # Build everything into local variables first.
        # The current snapshot is only replaced after all validation/building succeeds
        direction_lookup = self._build_direction_lookup(trips_df)
        stop_times_lookup = self._build_stop_times_lookup(stop_times_df)
        stops_lookup = self._build_stops_lookup(stops_df)
        routes_lookup = self._build_routes_lookup(routes_df)
        trip_route_lookup = self._build_trip_route_lookup(trips_df)
        version = self._compute_version()

        self.direction_lookup = direction_lookup
        self.stop_times_lookup = stop_times_lookup
        self.stops_lookup = stops_lookup
        self.routes_lookup = routes_lookup
        self.trip_route_lookup = trip_route_lookup
        self._current_version = version

    def has_changed(self) -> bool:
        """
        Check whether the on-disk GTFS bundle differs from what's currently loaded,
        WITHOUT reloading it. Call load() again if this returns True.

        Prefers feed_info.txt's feed_version when the bundle provides one (the
        authoritative signal MBTA intends consumers to use); falls back to a
        lightweight file fingerprint (size + mtime of the three required files)
        when feed_info.txt is absent -- not every GTFS bundle includes it.
        """
        if self._current_version is None:
            return True  # never loaded yet
        return self._compute_version() != self._current_version

    def reload_if_changed(self) -> bool:
        """Convenience wrapper: reload only if has_changed() is True. Returns
        whether a reload actually happened."""
        if self.has_changed():
            try:
                self.load()
                return True
            except (
                FileNotFoundError, 
                ValueError, 
                pd.errors.EmptyDataError, 
                pd.errors.ParserError
                ):
                # The exception is not raised here. The system continues to use
                # the old, valid snapshot (self.direction_lookup, etc.)
                return False
        return False

    # --- internals ---

    def _build_active_service_ids(self) -> set[str] | None:
        """Compute the set of service_ids active today ± 1 day.

        Reads calendar.txt (day-of-week patterns with date ranges) and
        calendar_dates.txt (exception dates that add/remove service).
        Returns None if neither file exists (no filtering — keep all trips).
        Returns a set of service_id strings otherwise.

        The ±1 day margin handles midnight-crossing trips: the consumer may
        process a ping shortly after a service-day rollover, and the
        resolve_scheduled_datetime nearest-anchor matching already spans
        previous/same/next calendar day.
        """
        calendar_path = self.gtfs_dir / "calendar.txt"
        calendar_dates_path = self.gtfs_dir / "calendar_dates.txt"

        if not calendar_path.exists() and not calendar_dates_path.exists():
            return None  # keep everything

        today = datetime.now(tz=UTC).date()
        target_dates = [today - timedelta(days=1), today, today + timedelta(days=1)]
        active: set[str] = set()

        # calendar.txt: service_id active on a date if the day-of-week flag
        # is 1 AND the date falls within start_date..end_date.
        if calendar_path.exists():
            try:
                cal = pd.read_csv(
                    calendar_path,
                    dtype={
                        "service_id": str, 
                        "start_date": str, 
                        "end_date": str
                    },
                )
                day_cols = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
                for row in cal.itertuples():
                    start = str(row.start_date)
                    end = str(row.end_date)
                    for d in target_dates:
                        d_str = d.strftime("%Y%m%d")
                        if start <= d_str <= end:
                            day_idx = d.weekday()  # Monday=0
                            if getattr(row, day_cols[day_idx], 0) == 1:
                                active.add(str(row.service_id))
                                break
            except (pd.errors.EmptyDataError, pd.errors.ParserError):
                logger.warning("calendar.txt is empty or malformed, skipping.")

        # calendar_dates.txt: exception_type 1 = added, 2 = removed.
        if calendar_dates_path.exists():
            try:
                cal_dates = pd.read_csv(
                    calendar_dates_path,
                    dtype={
                        "service_id": str, 
                        "date": str
                    },
                )
                target_strs = {d.strftime("%Y%m%d") for d in target_dates}
                for row in cal_dates.itertuples():
                    d_str = str(row.date)
                    if d_str not in target_strs:
                        continue
                    sid = str(row.service_id)
                    if int(row.exception_type) == 1:
                        active.add(sid)
                    elif int(row.exception_type) == 2:
                        active.discard(sid)
            except (pd.errors.EmptyDataError, pd.errors.ParserError):
                logger.warning("calendar_dates.txt is empty or malformed, skipping.")

        return active if active else None

    def _validate_files_exist(self) -> None:
        missing = [
            filename 
           for filename in _REQUIRED_FILES 
           if not (self.gtfs_dir / filename).exists()
        ]
        if missing:
            raise FileNotFoundError(
                f"Missing required GTFS-static file(s) in "
                f"{self.gtfs_dir}: {missing}"
            )

    def _validate_columns(self, filename: str, df: pd.DataFrame) -> None:
        required = _REQUIRED_COLUMNS[filename]
        missing = required - set(df.columns)

        if missing:
            raise ValueError(
                f"Missing required column(s) in {filename}: "
                f"{sorted(missing)}"
            )

    @staticmethod
    def _build_direction_lookup(trips_df: pd.DataFrame) -> dict[str, int]:
        
        valid = trips_df.dropna(subset=["trip_id", "direction_id"])
        lookup: dict[str, int] = {}

        for row in valid.itertuples():
            trip_id = str(row.trip_id)
            direction_id = int(row.direction_id)

            if row.direction_id not in (0, 1):
                raise ValueError(
                    f"Invalid direction_id for trip {row.trip_id}: "
                    f"{row.direction_id}"
                )
            lookup[trip_id] = direction_id

        return lookup

    @staticmethod
    def _build_stop_times_lookup(
        stop_times_df: pd.DataFrame,
    ) -> dict[tuple[str, int], ScheduledStopTime]:
        lookup: dict[tuple[str, int], ScheduledStopTime] = {}

        has_stop_id = "stop_id" in stop_times_df.columns

        for row in stop_times_df.itertuples():
            trip_id = str(row.trip_id)
            stop_sequence = int(row.stop_sequence)

            if stop_sequence < 0:
                raise ValueError(
                    f"Invalid stop_sequence for trip {trip_id}: "
                    f"{stop_sequence}"
                )

            key = (trip_id, stop_sequence)
            # Pre-parse times to integer seconds-of-day for compact storage.
            # gtfs_time_to_seconds handles values >= 24:00:00 (past-midnight trips).
            arrival_time = (
                gtfs_time_to_seconds(str(row.arrival_time))
                if pd.notna(row.arrival_time)
                else None
            )
            departure_time = (
                gtfs_time_to_seconds(str(row.departure_time))
                if pd.notna(row.departure_time)
                else None
            )
            stop_id = (
                str(row.stop_id)
                if has_stop_id and pd.notna(row.stop_id)
                else None
            )

            lookup[key] = ScheduledStopTime(
                trip_id=trip_id,
                stop_sequence=stop_sequence,
                arrival_time=arrival_time,
                departure_time=departure_time,
                stop_id=stop_id,
            )
        return lookup

    @staticmethod
    def _build_stops_lookup(stops_df: pd.DataFrame) -> dict[str, StopInfo]:
        lookup: dict[str, StopInfo] = {}

        has_name = "stop_name" in stops_df.columns
        has_lat = "stop_lat" in stops_df.columns
        has_lon = "stop_lon" in stops_df.columns

        for row in stops_df.itertuples():
            stop_id = str(row.stop_id)

            stop_name = (
                str(row.stop_name)
                if has_name and pd.notna(row.stop_name)
                else None
            )
            stop_lat = (
                float(row.stop_lat)
                if has_lat and pd.notna(row.stop_lat)
                else None
            )
            stop_lon = (
                float(row.stop_lon)
                if has_lon and pd.notna(row.stop_lon)
                else None
            )

            lookup[stop_id] = StopInfo(
                stop_id=stop_id,
                stop_name=stop_name,
                stop_lat=stop_lat,
                stop_lon=stop_lon,
            )
        return lookup

    @staticmethod
    def _build_routes_lookup(routes_df: pd.DataFrame) -> dict[str, str | None]:
        """Build route_id -> route_long_name mapping from routes.txt.

        Stores None for missing names so the API returns null consistently
        rather than omitting the field (some MBTA shuttle routes lack a
        route_long_name).
        """
        lookup: dict[str, str | None] = {}
        for row in routes_df.itertuples():
            route_id = str(row.route_id)
            name = str(row.route_long_name) if pd.notna(row.route_long_name) else None
            lookup[route_id] = name
        return lookup

    @staticmethod
    def _build_trip_route_lookup(trips_df: pd.DataFrame) -> dict[str, str]:
        """Build trip_id -> route_id mapping from trips.txt.

        Used to resolve which route a deviation belongs to, without
        depending on the window's pings having both fields.
        """
        valid = trips_df.dropna(subset=["trip_id", "route_id"])
        return {str(row.trip_id): str(row.route_id) for row in valid.itertuples()}

    def _compute_version(self) -> str:
        feed_info_path = self.gtfs_dir / _OPTIONAL_VERSION_FILE

        if feed_info_path.exists():
            try:
                feed_info = pd.read_csv(feed_info_path)
            except (pd.errors.EmptyDataError, pd.errors.ParserError):
                feed_info = None

            if feed_info is not None and "feed_version" in feed_info.columns and len(feed_info) > 0:
                version = feed_info["feed_version"].iloc[0]

                if pd.notna(version):
                    return f"feed_version:{version}"

        return self._compute_file_fingerprint()

    def _compute_file_fingerprint(self) -> str:
        """
        Lightweight fingerprint: size + mtime of each required file. Cheap enough
        to call on every check cycle, unlike hashing full file contents:
        MBTA's stop_times.txt alone can be hundreds of thousands of rows.
        """
        parts = []

        for filename in _REQUIRED_FILES:
            stat = (self.gtfs_dir / filename).stat()
            parts.append(
                f"{filename}:{stat.st_size}:{int(stat.st_mtime)}"
            )

        fingerprint = "|".join(parts)

        return f"fingerprint:{hashlib.sha256(fingerprint.encode()).hexdigest()}"
