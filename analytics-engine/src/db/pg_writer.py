"""
Writes aggregated hourly route statistics to PostgreSQL.

Two responsibilities:
1. HourlyAccumulator. Collects per-window deviation/bunching data grouped
   by route, and flushes aggregated HourlyStats at hour boundaries.
2. PgWriter. Persists HourlyStats rows to the route_hourly_stats table
   via INSERT ... ON CONFLICT (upsert).

The accumulator sits in the analytics engine's on_window_result callback
alongside the existing MongoDB writer; both get every WindowResult, but
the PG accumulator only writes when the hour boundary is crossed.

Why accumulate in memory instead of SQL accumulation:
- p95 cannot be computed incrementally in SQL (needs all values for the hour).
- Keeping deviation values in memory for one hour is bounded (~few thousand
  across all routes) and lets us compute true percentiles.
- The upsert is a single clean write per route per hour, not a complex
  ON CONFLICT DO UPDATE with weighted-average formulas.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import TYPE_CHECKING

import psycopg2
from psycopg2.extensions import connection as PgConnection
from psycopg2.extras import execute_values

from db.pg_connection import connect_pg_with_retry
from db.pg_schema import (
    ROUTE_HOURLY_STATS_DDL,
    ROUTE_HOURLY_STATS_INDEX_DDL,
    HourlyStats,
)
from utils.logger import get_logger

if TYPE_CHECKING:
    from consumer import WindowResult

logger = get_logger("analytics-engine.pg_writer")

ON_TIME_THRESHOLD_SECONDS = 180

def _compute_p95(sorted_values: list[float]) -> float:
    """Nearest-rank percentile (same algorithm as routePerformance.ts).
    Input must be sorted ascending. Returns 0 for an empty list."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    
    float_index = 0.95 * (len(sorted_values) - 1)
    lower_index = max(0, int(float_index))
    upper_index = min(len(sorted_values) - 1, lower_index + 1)
    weight = float_index - lower_index

    return sorted_values[lower_index] * (1 - weight) + sorted_values[upper_index] * weight


class HourlyAccumulator:
    """
    Collects per-window, per-route deviation and bunching data, and flushes
    aggregated HourlyStats when the hour boundary is crossed.

    Usage in main.py's on_window_result callback:

        accumulator.accumulate(window_result)
        flushed = accumulator.maybe_flush(current_time)
        if flushed:
            pg_writer.upsert_hourly_stats(flushed)
    """

    def __init__(self) -> None:
        self._current_hour: datetime | None = None
        # Per-route accumulators for the current hour.
        # deviations: list of |deviation_seconds| values (for p95)
        # vehicle_ids: set of distinct vehicles (for vehicle_count)
        # on_time_count / total_count: for on_time_pct
        # new_bunching: count of "new" bunching actions only
        self._route_data: dict[str, dict] = defaultdict(lambda: {
            "deviations": [],
            "vehicle_ids": set(),
            "on_time_count": 0,
            "total_count": 0,
            "new_bunching": 0,
        })

    def accumulate(self, result: WindowResult) -> None:
        """Feed one window's results into the accumulator.

        Deviations are grouped by route_id. Bunching actions are counted
        by "new" only: an "update" action means the event was already
        counted in a previous window/hour.
        """
        for dev in result.new_deviations:
            route_id = dev.route_id or "unknown"
            data = self._route_data[route_id]
            abs_dev = abs(dev.deviation_seconds)
            data["deviations"].append(abs_dev)
            data["vehicle_ids"].add(dev.vehicle_id)
            data["total_count"] += 1
            if abs_dev <= ON_TIME_THRESHOLD_SECONDS:
                data["on_time_count"] += 1

        for action, event in result.bunching_actions:
            if action == "new":
                self._route_data[event.route_id]["new_bunching"] += 1

    def maybe_flush(self, reference_time: datetime) -> list[HourlyStats] | None:
        """Check if the hour boundary has been crossed. If so, aggregate
        the accumulated data into HourlyStats rows and reset.

        Args:
            reference_time: The current time (timezone-aware). Used to
                determine the hour boundary.

        Returns:
            List of HourlyStats if the hour changed, None otherwise.
        """
        # Truncate to hour boundary
        current_hour = reference_time.replace(minute=0, second=0, microsecond=0)

        if self._current_hour is None:
            # First call. Just record the hour, don't flush empty data.
            self._current_hour = current_hour
            return None

        if current_hour == self._current_hour:
            # Still in the same hour, keep accumulating.
            return None

        # Hour boundary crossed; flush previous hour's data.
        flushed = self._flush(self._current_hour)
        self._current_hour = current_hour
        return flushed

    def flush_remaining(self) -> list[HourlyStats] | None:
        """Flush whatever has accumulated so far. Called on shutdown to
        avoid losing the current partial hour's data."""
        if self._current_hour is None or not self._route_data:
            return None
        return self._flush(self._current_hour)

    def _flush(self, hour: datetime) -> list[HourlyStats]:
        """Aggregate accumulated data into HourlyStats rows and reset."""
        stats: list[HourlyStats] = []
        for route_id, data in self._route_data.items():
            if data["total_count"] == 0 and data["new_bunching"] == 0:
                continue

            sorted_devs = sorted(data["deviations"])
            total = data["total_count"]

            stats.append(HourlyStats(
                route_id=route_id,
                hour=hour,
                avg_deviation=(sum(sorted_devs) / total) if total > 0 else 0.0,
                p95_deviation=_compute_p95(sorted_devs),
                vehicle_count=len(data["vehicle_ids"]),
                on_time_pct=round((data["on_time_count"] / total) * 100, 1) if total > 0 else 0.0,
                bunching_events=data["new_bunching"],
            ))

        self._route_data.clear()
        logger.info(
            "Flushed %d route(s) for hour %s to PostgreSQL accumulator",
            len(stats), hour.isoformat(),
        )
        return stats


class PgWriter:
    """
    Persists HourlyStats rows to PostgreSQL.

    Usage:
        pg_writer = PgWriter(dsn)
        pg_writer.upsert_hourly_stats(hourly_stats_list)
        pg_writer.close()
    """

    def __init__(self, dsn: str):
        self._dsn = dsn
        self._conn: PgConnection = self._connect()
        self._ensure_table()

    def _connect(self) -> PgConnection:
        """Connect using function from pg_connection.py."""
        return connect_pg_with_retry(self._dsn)

    def _ensure_table(self) -> None:
        """Create the route_hourly_stats table and index if they don't exist.
        Uses autocommit for DDL"""
        old_autocommit = self._conn.autocommit
        self._conn.autocommit = True
        try:
            with self._conn.cursor() as cur:
                cur.execute(ROUTE_HOURLY_STATS_DDL)
                cur.execute(ROUTE_HOURLY_STATS_INDEX_DDL)
            logger.info("Ensured route_hourly_stats table and index exist.")
        finally:
            self._conn.autocommit = old_autocommit

    def upsert_hourly_stats(self, stats: list[HourlyStats]) -> int:
        """Upsert a batch of HourlyStats rows.

        Uses INSERT ... ON CONFLICT (route_id, hour) DO UPDATE so that
        re-running the same hour (e.g. after a restart) replaces the
        previous row rather than creating a duplicate.

        Returns the number of rows written (0 on failure).
        """
        if not stats:
            return 0

        sql = """
            INSERT INTO route_hourly_stats
                (route_id, hour, avg_deviation, p95_deviation,
                 vehicle_count, on_time_pct, bunching_events)
            VALUES %s
            ON CONFLICT (route_id, hour) DO UPDATE SET
                avg_deviation = EXCLUDED.avg_deviation,
                p95_deviation = EXCLUDED.p95_deviation,
                vehicle_count = EXCLUDED.vehicle_count,
                on_time_pct = EXCLUDED.on_time_pct,
                bunching_events = EXCLUDED.bunching_events
        """

        rows = [
            (s.route_id, s.hour, s.avg_deviation, s.p95_deviation,
             s.vehicle_count, s.on_time_pct, s.bunching_events)
            for s in stats
        ]

        try:
            with self._conn.cursor() as cur:
                execute_values(cur, sql, rows)
            self._conn.commit()
            logger.info("Upserted %d hourly stat(s) to PostgreSQL.", len(rows))
            return len(rows)
        except psycopg2.Error:
            logger.exception("Failed to upsert %d hourly stat(s).", len(rows))
            self._conn.rollback()
            return 0

    def close(self) -> None:
        """Close the PostgreSQL connection. Called on shutdown."""
        try:
            self._conn.close()
            logger.info("PostgreSQL connection closed.")
        except Exception:
            logger.warning("Error closing PostgreSQL connection.", exc_info=True)