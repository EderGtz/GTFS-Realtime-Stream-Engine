"""
Unit tests for db/pg_writer.py — HourlyAccumulator and PgWriter.

HourlyAccumulator is tested with pure dataclass inputs (no I/O), matching
the project's convention of testing logic without live connections.
PgWriter is tested with mocked psycopg2 to verify SQL shape
and error handling without requiring a live PostgreSQL.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from db.pg_schema import HourlyStats
from db.pg_writer import (
    HourlyAccumulator,
    PgWriter,
    _compute_p95,
)


# ── Helpers: lightweight fakes matching WindowResult's shape ──────────

class FakeDeviation:
    def __init__(self, vehicle_id: str, deviation_seconds: float, route_id: str | None = "28"):
        self.vehicle_id = vehicle_id
        self.deviation_seconds = deviation_seconds
        self.route_id = route_id


class FakeBunchingEvent:
    def __init__(self, route_id: str = "28"):
        self.route_id = route_id


class FakeWindowResult:
    def __init__(self, deviations=None, bunching_actions=None):
        self.new_deviations = deviations or []
        self.bunching_actions = bunching_actions or []
        self.total_records = len(self.new_deviations)


def _utc(y, m, d, h, mi=0, s=0):
    return datetime(y, m, d, h, mi, s, tzinfo=timezone.utc)


# ── _compute_p95 ─────────────────────────────────────────────────────

class TestComputeP95:
    def test_empty_list_returns_zero(self):
        assert _compute_p95([]) == 0.0

    def test_single_value_returns_itself(self):
        assert _compute_p95([42.0]) == 42.0

    def test_simple_known_percentile(self):
        values = [float(i) for i in range(1, 101)]
        result = _compute_p95(values)
        assert 95.0 <= result <= 96.0

    def test_all_same_values(self):
        assert _compute_p95([10.0, 10.0, 10.0]) == 10.0

    def test_sorted_input_interpolation(self):
        # p95 of [1..5]: index = 0.95 * 4 = 3.8, interpolate between 4 and 5.
        values = [1.0, 2.0, 3.0, 4.0, 5.0]
        result = _compute_p95(values)
        assert result == pytest.approx(4.8)


# ── HourlyAccumulator ────────────────────────────────────────────────

class TestHourlyAccumulator:
    def test_first_maybe_flush_returns_none(self):
        acc = HourlyAccumulator()
        assert acc.maybe_flush(_utc(2026, 10, 5, 10, 30)) is None

    def test_same_hour_does_not_flush(self):
        acc = HourlyAccumulator()
        acc.accumulate(FakeWindowResult(deviations=[FakeDeviation("V1", 120)]))
        assert acc.maybe_flush(_utc(2026, 10, 5, 10, 15)) is None
        acc.accumulate(FakeWindowResult(deviations=[FakeDeviation("V2", 60)]))
        assert acc.maybe_flush(_utc(2026, 10, 5, 10, 45)) is None

    def test_hour_boundary_flushes_accumulated_data(self):
        acc = HourlyAccumulator()
        acc.accumulate(FakeWindowResult(deviations=[FakeDeviation("V1", 120, "28")]))
        acc.maybe_flush(_utc(2026, 10, 5, 10, 15))

        flushed = acc.maybe_flush(_utc(2026, 10, 5, 11, 5))
        assert flushed is not None
        assert len(flushed) == 1
        assert flushed[0].route_id == "28"
        assert flushed[0].vehicle_count == 1

    def test_groups_deviation_by_route(self):
        acc = HourlyAccumulator()
        acc.accumulate(FakeWindowResult(deviations=[
            FakeDeviation("V1", 120, "28"),
            FakeDeviation("V2", 60, "28"),
            FakeDeviation("V3", 300, "Red"),
        ]))
        acc.maybe_flush(_utc(2026, 10, 5, 10, 15))

        flushed = acc.maybe_flush(_utc(2026, 10, 5, 11, 5))
        routes = {s.route_id: s for s in flushed}
        assert len(routes) == 2
        assert routes["28"].vehicle_count == 2
        assert routes["Red"].vehicle_count == 1

    def test_vehicle_count_is_deduplicated(self):
        acc = HourlyAccumulator()
        acc.accumulate(FakeWindowResult(deviations=[
            FakeDeviation("V1", 120, "28"),
            FakeDeviation("V1", 200, "28"),
            FakeDeviation("V1", 50, "28"),
        ]))
        acc.maybe_flush(_utc(2026, 10, 5, 10, 15))

        flushed = acc.maybe_flush(_utc(2026, 10, 5, 11, 5))
        assert flushed[0].vehicle_count == 1
        assert flushed[0].avg_deviation == pytest.approx(123.3, abs=0.1)

    def test_bunching_counts_new_only(self):
        acc = HourlyAccumulator()
        acc.accumulate(FakeWindowResult(bunching_actions=[
            ("new", FakeBunchingEvent("28")),
            ("new", FakeBunchingEvent("28")),
            ("update", FakeBunchingEvent("28")),
        ]))
        acc.maybe_flush(_utc(2026, 10, 5, 10, 15))

        flushed = acc.maybe_flush(_utc(2026, 10, 5, 11, 5))
        assert flushed[0].bunching_events == 2

    def test_on_time_pct_calculation(self):
        acc = HourlyAccumulator()
        acc.accumulate(FakeWindowResult(deviations=[
            FakeDeviation("V1", 120, "28"),
            FakeDeviation("V2", -60, "28"),
            FakeDeviation("V3", 300, "28"),
            FakeDeviation("V4", 450, "28"),
        ]))
        acc.maybe_flush(_utc(2026, 10, 5, 10, 15))

        flushed = acc.maybe_flush(_utc(2026, 10, 5, 11, 5))
        assert flushed[0].on_time_pct == pytest.approx(50.0, abs=0.1)

    def test_flush_remaining_returns_partial_hour(self):
        acc = HourlyAccumulator()
        acc.accumulate(FakeWindowResult(deviations=[FakeDeviation("V1", 120, "28")]))
        acc.maybe_flush(_utc(2026, 10, 5, 10, 15))

        remaining = acc.flush_remaining()
        assert remaining is not None
        assert len(remaining) == 1
        assert remaining[0].route_id == "28"

    def test_flush_remaining_with_no_data_returns_none(self):
        acc = HourlyAccumulator()
        assert acc.flush_remaining() is None

    def test_flush_resets_accumulator(self):
        acc = HourlyAccumulator()
        acc.accumulate(FakeWindowResult(deviations=[FakeDeviation("V1", 120, "28")]))
        acc.maybe_flush(_utc(2026, 10, 5, 10, 15))

        flushed = acc.maybe_flush(_utc(2026, 10, 5, 11, 5))
        assert flushed is not None

        # Next flush should have no leftover data from the previous hour.
        flushed2 = acc.maybe_flush(_utc(2026, 10, 5, 12, 5))
        if flushed2:
            assert all(s.vehicle_count == 0 for s in flushed2)


# ── PgWriter (mocked connection) ─────────────────────────────────────

def _make_writer():
    """Create a PgWriter with mocked connection and execute_values."""
    with patch("db.pg_writer.connect_pg_with_retry") as mock_connect:
        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn
        writer = PgWriter(dsn="postgresql://fake")
    return writer, mock_conn


class TestPgWriter:
    @patch("db.pg_writer.execute_values")
    def test_ensure_table_executes_ddl(self, _mock_ev):
        writer, mock_conn = _make_writer()
        cursor = mock_conn.cursor.return_value.__enter__.return_value
        executed_sql = [str(c) for c in cursor.execute.call_args_list]
        assert any("route_hourly_stats" in sql for sql in executed_sql)
        assert any("CREATE INDEX" in sql for sql in executed_sql)

    @patch("db.pg_writer.execute_values")
    def test_upsert_hourly_stats_commits(self, mock_ev):
        writer, mock_conn = _make_writer()
        stats = [HourlyStats(
            route_id="28", hour=_utc(2026, 10, 5, 10),
            avg_deviation=100.0, p95_deviation=200.0,
            vehicle_count=5, on_time_pct=80.0, bunching_events=1,
        )]
        result = writer.upsert_hourly_stats(stats)
        assert result == 1
        mock_conn.commit.assert_called_once()
        mock_ev.assert_called_once()

    @patch("db.pg_writer.execute_values")
    def test_upsert_empty_list_returns_zero(self, _mock_ev):
        writer, _mock_conn = _make_writer()
        assert writer.upsert_hourly_stats([]) == 0

    @patch("db.pg_writer.execute_values")
    def test_upsert_failure_rolls_back(self, mock_ev):
        import psycopg2
        mock_ev.side_effect = psycopg2.Error("boom")
        writer, mock_conn = _make_writer()
        stats = [HourlyStats(
            route_id="28", hour=_utc(2026, 10, 5, 10),
            avg_deviation=100.0, p95_deviation=200.0,
            vehicle_count=5, on_time_pct=80.0, bunching_events=1,
        )]
        result = writer.upsert_hourly_stats(stats)
        assert result == 0
        mock_conn.rollback.assert_called_once()

    @patch("db.pg_writer.execute_values")
    def test_close_closes_connection(self, _mock_ev):
        writer, mock_conn = _make_writer()
        writer.close()
        mock_conn.close.assert_called_once()
