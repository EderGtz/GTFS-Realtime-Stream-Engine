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
from pathlib import Path

import pandas as pd

from metrics.schedule_deviation import ScheduledStopTime

_REQUIRED_FILES = ("stops.txt", "trips.txt", "stop_times.txt")
_OPTIONAL_VERSION_FILE = "feed_info.txt"

# analytics-engine/src/gtfs_static/loader.py. parents[2] == analytics-engine/
_DEFAULT_GTFS_DIR = Path(__file__).resolve().parents[2] / "gtfs_static" / "MBTA_GTFS"

_REQUIRED_COLUMNS = {
    "trips.txt": {"trip_id", "direction_id"},
    "stop_times.txt": {
        "trip_id",
        "stop_sequence",
        "arrival_time",
        "departure_time",
    },
    "stops.txt": {"stop_id"},
}


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

        self._current_version: str | None = None

    def load(self) -> None:
        """
        Read all three required files fresh and rebuild every lookup. 
        
        Raises:
            FileNotFoundError: If a required GTFS file is missing.
            ValueError: If a required file is missing one or more required columns.
        """
        self._validate_files_exist()

        trips_df = pd.read_csv(
            self.gtfs_dir / "trips.txt", 
            dtype={"trip_id": str, "route_id": str},
        )
        stop_times_df = pd.read_csv(
            self.gtfs_dir / "stop_times.txt", 
            dtype={"trip_id": str, "stop_id": str},
        )
        stops_df = pd.read_csv(
            self.gtfs_dir / "stops.txt", 
            dtype={"stop_id": str},
        )

        self._validate_columns("trips.txt", trips_df)
        self._validate_columns("stop_times.txt", stop_times_df)
        self._validate_columns("stops.txt", stops_df)

        # Build everything into local variables first.
        # The current snapshot is only replaced after all validation/building succeeds
        direction_lookup = self._build_direction_lookup(trips_df)
        stop_times_lookup = self._build_stop_times_lookup(stop_times_df)
        stops_lookup = self._build_stops_lookup(stops_df)

        self.direction_lookup = direction_lookup
        self.stop_times_lookup = stop_times_lookup
        self.stops_lookup = stops_lookup
        self._current_version = self._compute_version()

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
            self.load()
            return True
        return False

    # --- internals ---

    def _validate_files_exist(self) -> None:
        missing = [filename 
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
        if "direction_id" not in trips_df.columns:
            return {}
        
        valid = trips_df.dropna(subset=["trip_id", "direction_id"])
        lookup: dict[str, int] = {}

        for row in valid.itertuples():
            if row.direction_id not in (0, 1):
                raise ValueError(
                    f"Invalid direction_id for trip {row.trip_id}: "
                    f"{row.direction_id}"
                )
            lookup[row.trip_id] = int(row.direction_id)

        return lookup

    @staticmethod
    def _build_stop_times_lookup(
        stop_times_df: pd.DataFrame,
    ) -> dict[tuple[str, int], ScheduledStopTime]:
        lookup: dict[tuple[str, int], ScheduledStopTime] = {}

        for row in stop_times_df.itertuples():
            key = (row.trip_id, int(row.stop_sequence))

            lookup[key] = ScheduledStopTime(
                trip_id=row.trip_id,
                stop_sequence=int(row.stop_sequence),
                arrival_time=row.arrival_time if pd.notna(row.arrival_time) else None,
                departure_time=row.departure_time if pd.notna(row.departure_time) else None,
            )
        return lookup

    @staticmethod
    def _build_stops_lookup(stops_df: pd.DataFrame) -> dict[str, StopInfo]:
        lookup: dict[str, StopInfo] = {}
        has_name = "stop_name" in stops_df.columns
        has_lat = "stop_lat" in stops_df.columns
        has_lon = "stop_lon" in stops_df.columns

        for row in stops_df.itertuples():
            lookup[row.stop_id] = StopInfo(
                stop_id=row.stop_id,
                stop_name=(row.stop_name if has_name and pd.notna(row.stop_name) else None),
                stop_lat=(float(row.stop_lat) if has_lat and pd.notna(row.stop_lat) else None),
                stop_lon=(float(row.stop_lon) if has_lon and pd.notna(row.stop_lon) else None),
            )
        return lookup

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
