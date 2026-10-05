"""
Schema definition and data types for the route_hourly_stats table.

The table stores pre-aggregated hourly statistics per route, written by
the HourlyAccumulator and queried by the API's GET /v1/routes/:id/history
endpoint. One row per (route_id, hour), upserted on conflict so the
same hour can be re-written if the analytics engine restarts mid-hour.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

# Executed once on startup by PgWriter._ensure_table().
# Uses TIMESTAMPTZ so the hour boundary is timezone-aware.
ROUTE_HOURLY_STATS_DDL = """
CREATE TABLE IF NOT EXISTS route_hourly_stats (
    route_id       TEXT NOT NULL,
    hour           TIMESTAMPTZ NOT NULL,
    avg_deviation  DOUBLE PRECISION,
    p95_deviation  DOUBLE PRECISION,
    vehicle_count  INTEGER,
    on_time_pct    DOUBLE PRECISION,
    bunching_events INTEGER,
    PRIMARY KEY (route_id, hour)
);
"""

@dataclass(frozen=True)
class HourlyStats:
    """One row in route_hourly_stats. Produced by HourlyAccumulator.flush()."""
    route_id: str
    hour: datetime           # truncated to hour boundary, timezone-aware
    avg_deviation: float     # mean |deviation_seconds| for the hour
    p95_deviation: float     # 95th percentile |deviation_seconds|
    vehicle_count: int       # distinct vehicles observed
    on_time_pct: float       # % of deviations within ±3 min (APTA standard)
    bunching_events: int     # new bunching events first detected this hour

# Index for the history query.
# Without it, every GET /v1/routes/:id/history does a sequential scan
# filtered by route_id, which is actually fine at MVP scale, but the index costs almost
# nothing and makes the query plan obvious.
ROUTE_HOURLY_STATS_INDEX_DDL = """
CREATE INDEX IF NOT EXISTS idx_route_hourly_route_hour
    ON route_hourly_stats (route_id, hour DESC);
"""
