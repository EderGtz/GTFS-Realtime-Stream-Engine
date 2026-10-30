"""Tests for compact.compact_day.

Each test writes a realistic day of ``HH.ndjson.gz``
files under ``tmp_path`` (values shaped exactly like ingestion-service's
producer.ts output), runs ``compact_day``, and asserts the produced
``parquet/date=<day>/`` against five guarantees:

  (a) rows out == lines in,
  (b) ``raw`` is byte-identical to the source lines (the fidelity gate),
  (c) promoted columns are typed correctly, lon/lat order preserved,
  (d) the output opens cleanly in pyarrow and pandas,
  (e) an unknown extra field compacts fine (and lands only in ``raw``).

DuckDB is an in-process engine, so these run without Docker and in well under a
second, same as the eligibility tests.
"""

from __future__ import annotations

import gzip
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from compact import VerificationError, compact_day, delete_raw_day, verify_counts


# Build a telemetry dict in the exact key order producer.ts emits (agency_id
# first, ingested_at last), then serialize it the way JSON.stringify does: no
# spaces, no ASCII-escaping, insertion-key order. json.dumps with those separators
# is byte-identical to JS JSON.stringify for these ASCII values.
def to_json(telemetry: dict) -> str:
    return json.dumps(telemetry, separators=(",", ":"), ensure_ascii=False)


def vehicle(
    *,
    vehicle_id: str,
    timestamp: str,
    lon: float,
    lat: float,
    trip_id: str | None = None,
    route_id: str | None = None,
    direction_id: int | None = None,
    bearing: float | None = None,
    speed: float | None = None,
    current_stop_sequence: int | None = None,
    stop_id: str | None = None,
    current_status: str | None = None,
    ingested_at: str = "2026-10-21T14:30:01.000Z",
) -> dict:
    """A single vehicle-position telemetry dict in producer key order."""
    return {
        "agency_id": "mbta",
        "vehicle_id": vehicle_id,
        "trip_id": trip_id,
        "route_id": route_id,
        "timestamp": timestamp,
        "direction_id": direction_id,
        "location": {"type": "Point", "coordinates": [lon, lat]},
        "bearing": bearing,
        "speed": speed,
        "current_stop_sequence": current_stop_sequence,
        "stop_id": stop_id,
        "current_status": current_status,
        "ingested_at": ingested_at,
    }


def write_hour(day_dir: Path, hour: str, lines: list[str]) -> None:
    """Gzip ``lines`` into ``<day_dir>/<hour>.ndjson.gz``, one line + newline each."""
    with gzip.open(day_dir / f"{hour}.ndjson.gz", "wb") as f:
        for line in lines:
            f.write(line.encode("utf-8"))
            f.write(b"\n")


def build_day(tmp_path: Path, day: str, hours: dict[str, list[str]]) -> Path:
    """Create ``tmp_path/<day>/`` and populate the given per-hour line lists."""
    day_dir = tmp_path / day
    day_dir.mkdir(parents=True)
    for hour, lines in hours.items():
        write_hour(day_dir, hour, lines)
    return day_dir


def read_raw(tmp_path: Path, day: str) -> list[str]:
    """Convenience: return every ``raw`` value from the produced Parquet, sorted."""
    import duckdb

    con = duckdb.connect()
    try:
        rows = con.execute(
            "SELECT raw FROM read_parquet(?) ORDER BY raw",
            [str(tmp_path / "parquet" / f"date={day}" / "*.parquet")],
        ).fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]


# Realistic fixture lines, built once at import so several tests can share them
# while still knowing their exact bytes. A mix of a fully-populated vehicle, a
# mostly-null one, and one carrying an unknown future field.
FULL_LINE = to_json(
    vehicle(
        vehicle_id="v1",
        timestamp="2026-10-21T14:30:00.000Z",
        lon=-71.0589,
        lat=42.3601,
        trip_id="t1",
        route_id="Red",
        direction_id=1,
        bearing=287.5,
        speed=12.3,
        current_stop_sequence=5,
        stop_id="70001",
        current_status="IN_TRANSIT_TO",
    )
)

NULL_LINE = to_json(
    vehicle(
        vehicle_id="v2",
        timestamp="2026-10-21T14:31:00.000Z",
        lon=-71.1000,
        lat=42.2000,
    )
)

# An unknown-extra-field line: "future_field" is not in the fixed schema and
# must survive verbatim in `raw` only. Also note -71.2 / 42.35 number formatting.
EXTRA_LINE = to_json(
    {
        "agency_id": "mbta",
        "vehicle_id": "v3",
        "trip_id": "t3",
        "route_id": "Blue",
        "timestamp": "2026-10-21T14:32:00.000Z",
        "direction_id": 0,
        "location": {"type": "Point", "coordinates": [-71.2, 42.35]},
        "bearing": 12.0,
        "speed": 0.6,
        "current_stop_sequence": 3,
        "stop_id": "70003",
        "current_status": "STOPPED_AT",
        "ingested_at": "2026-10-21T14:32:01.000Z",
        "future_field": "kept only in raw",
    }
)

DAY = "2026-10-22"


def make_two_hour_day(tmp_path: Path) -> tuple[list[str], Path]:
    """A day with two hourly files (00, 03) and all three fixture lines."""
    lines = [FULL_LINE, NULL_LINE, EXTRA_LINE]
    day_dir = build_day(tmp_path, DAY, {"00": lines[:2], "03": lines[2:]})
    return lines, day_dir


# ── (a) rows out == lines in ────────────────────────────────────────────────


def test_rows_out_equal_lines_in(tmp_path: Path):
    lines, _ = make_two_hour_day(tmp_path)
    result = compact_day(tmp_path, DAY)

    assert result.source_lines == len(lines)
    assert result.parquet_rows == len(lines)
    assert result.source_lines == result.parquet_rows


# ── (b) raw column byte-identical to source lines (fidelity gate) ───────────


def test_raw_column_is_byte_identical(tmp_path: Path):
    """The fidelity gate: `raw` must equal the input lines byte-for-byte.

    If this ever regresses to "parse then re-serialize", key order and number
    formatting would drift and this assert — comparing exact bytes — would fail,
    which is the property that lets Task 11 delete the raw tier at all.
    """
    lines, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)

    assert sorted(read_raw(tmp_path, DAY)) == sorted(lines)


def test_raw_preserves_exact_number_formatting(tmp_path: Path):
    """A value whose re-serialization would change is preserved exactly.

    ``-71.2`` / ``12.0`` style formatting is easy for a parser to normalize
    (e.g. to ``-71.200000000000003`` or ``12``); the line must stay untouched.
    """
    build_day(tmp_path, DAY, {"00": [EXTRA_LINE]})
    compact_day(tmp_path, DAY)

    assert read_raw(tmp_path, DAY) == [EXTRA_LINE]
    assert '"coordinates":[-71.2,42.35]' in EXTRA_LINE  # the exact bytes we wrote


# ── (c) promoted columns typed correctly, lon/lat order preserved ───────────


def test_promoted_columns_typed_and_lon_lat_order(tmp_path: Path):
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)

    table = pq.read_table(str(tmp_path / "parquet" / f"date={DAY}"))
    schema = table.schema

    # String columns.
    for name in (
        "agency_id",
        "vehicle_id",
        "trip_id",
        "route_id",
        "stop_id",
        "current_status",
        "raw",
    ):
        assert pa.types.is_string(schema.field(name).type), name

    # Integral columns.
    for name in ("direction_id", "current_stop_sequence"):
        assert pa.types.is_integer(schema.field(name).type), name

    # Floating-point columns.
    for name in ("bearing", "speed"):
        assert pa.types.is_floating(schema.field(name).type), name

    # Temporal columns.
    for name in ("timestamp", "ingested_at"):
        assert pa.types.is_timestamp(schema.field(name).type), name

    # Nested GeoJSON location: struct(type, coordinates: list<double>), order kept.
    loc_type = schema.field("location").type
    assert pa.types.is_struct(loc_type)
    coords_field = loc_type.field("coordinates")
    assert pa.types.is_list(coords_field.type)
    assert pa.types.is_floating(coords_field.type.value_type)

    # Value-level checks on the fully-populated vehicle, including lon/lat order.
    v1 = table.filter(pa.compute.equal(table["vehicle_id"], "v1"))
    assert v1["direction_id"].to_pylist() == [1]
    assert v1["bearing"].to_pylist()[0] == pytest.approx(287.5)
    loc = v1["location"].to_pylist()[0]
    assert loc == {"type": "Point", "coordinates": [-71.0589, 42.3601]}
    # lon first, lat second — the GeoJSON [lon, lat] order is not transposed.
    assert loc["coordinates"][0] == -71.0589
    assert loc["coordinates"][1] == 42.3601
    assert v1["timestamp"].to_pylist()[0] == datetime(2026, 10, 21, 14, 30)


# ── (d) output opens cleanly in pyarrow and pandas ──────────────────────────


def test_output_opens_in_pyarrow_and_pandas(tmp_path: Path):
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)
    parquet_dir = tmp_path / "parquet" / f"date={DAY}"

    # pyarrow.
    table = pq.read_table(str(parquet_dir))
    assert table.num_rows == 3
    assert table.num_columns == 14  # 13 promoted + raw

    # pandas (also confirms the day's data is queryable end-to-end).
    df = pd.read_parquet(str(parquet_dir))
    assert df.shape == (3, 14)
    assert set(df["vehicle_id"]) == {"v1", "v2", "v3"}


def test_output_is_zstd_compressed(tmp_path: Path):
    _, _ = make_two_hour_day(tmp_path)
    result = compact_day(tmp_path, DAY)

    parquet_file = next((tmp_path / result.output_dir).glob("*.parquet"))
    metadata = pq.ParquetFile(parquet_file).metadata
    assert metadata.row_group(0).column(0).compression == "ZSTD"


# ── (e) schema stability: unknown extra field lands in `raw` only ────────────


def test_unknown_field_compacts_and_stays_in_raw_only(tmp_path: Path):
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)

    table = pq.read_table(str(tmp_path / "parquet" / f"date={DAY}"))
    # "future_field" is not a promoted column of the fixed schema...
    assert "future_field" not in table.column_names

    # ...but the v3 row's `raw` still carries it, byte-for-byte.
    v3 = table.filter(pa.compute.equal(table["vehicle_id"], "v3"))
    assert len(v3) == 1
    assert v3["raw"].to_pylist()[0] == EXTRA_LINE
    assert "future_field" in v3["raw"].to_pylist()[0]


# ── Robustness extras ────────────────────────────────────────────────────────


def test_malformed_known_field_degrades_to_null_not_error(tmp_path: Path):
    """A malformed value in a *known* field becomes NULL, not a failed COPY.

    This is the TRY_CAST guarantee: one bad row must not take the whole day
    down, and the original survives in `raw`.
    """
    bad = to_json(
        {
            "agency_id": "mbta",
            "vehicle_id": "v9",
            "trip_id": "t9",
            "route_id": "Green",
            "timestamp": "not-a-date",
            "direction_id": "X",  # not an integer
            "location": {"type": "Point", "coordinates": ["bad", "data"]},
            "bearing": "oops",
            "speed": None,
            "current_stop_sequence": None,
            "stop_id": "s9",
            "current_status": None,
            "ingested_at": "2026-10-21T14:39:01.000Z",
        }
    )
    # Include a well-formed line too so we also prove the good one survives.
    good = to_json(
        vehicle(
            vehicle_id="v8", timestamp="2026-10-21T14:38:00.000Z", lon=-71.0, lat=42.0
        )
    )
    build_day(tmp_path, DAY, {"00": [good, bad]})

    result = compact_day(tmp_path, DAY)
    assert result.source_lines == 2
    assert result.parquet_rows == 2

    table = pq.read_table(str(tmp_path / "parquet" / f"date={DAY}"))
    bad_row = table.filter(pa.compute.equal(table["vehicle_id"], "v9"))
    # Scalar malformed fields null out cleanly rather than erroring the COPY.
    assert bad_row["direction_id"].to_pylist() == [None]
    assert bad_row["timestamp"].to_pylist() == [None]
    assert bad_row["bearing"].to_pylist() == [None]
    # The struct cast degrades leaf-level: `type` survives and the unparseable
    # coordinates become NULL *inside* the array. The property that matters is
    # the bad row did not abort the day — not the exact null shape DuckDB chose.
    assert bad_row["location"].to_pylist() == [
        {"type": "Point", "coordinates": [None, None]}
    ]
    assert bad_row["raw"].to_pylist()[0] == bad


def test_empty_day_is_a_noop(tmp_path: Path):
    """A day with no hourly files returns zero counts and a None output dir."""
    build_day(tmp_path, DAY, {})
    result = compact_day(tmp_path, DAY)

    assert result.source_files == ()
    assert result.source_lines == 0
    assert result.parquet_rows == 0
    assert result.output_dir is None
    assert not (tmp_path / "parquet").exists()


def test_source_files_sorted_and_consumed(tmp_path: Path):
    """Multiple hourly files are globbed in order and both are consumed."""
    _, _ = make_two_hour_day(tmp_path)
    result = compact_day(tmp_path, DAY)

    names = [Path(p).name for p in result.source_files]
    assert names == ["00.ndjson.gz", "03.ndjson.gz"]  # sorted, not fs-order
    assert result.day == DAY
    assert result.output_dir == str(tmp_path / "parquet" / f"date={DAY}")


def test_no_tmp_leftovers_after_success(tmp_path: Path):
    """The atomic publish leaves no hidden .tmp dir behind."""
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)

    parquet_root = tmp_path / "parquet"
    leftovers = [p.name for p in parquet_root.iterdir()]
    assert leftovers == [f"date={DAY}"]


# Verify-then-delete

# Fixed "now" so grace-window arithmetic is exact, not wall-clock dependent. The
# tests backdate dirs with os.utime relative to this instant.
NOW = datetime(2026, 10, 27, 3, 0, 0, tzinfo=UTC)
NOW_EPOCH = NOW.timestamp()


def backdate_dir(path: Path, days: int) -> None:
    """Set a dir's mtime to ``days`` days before the fixed NOW, via os.utime."""
    older = NOW_EPOCH - days * 86400
    os.utime(path, (older, older))


def raw_files(tmp_path: Path, day: str) -> list[str]:
    """Sorted names of the day's remaining raw ``.ndjson.gz`` files."""
    return sorted(p.name for p in (tmp_path / day).glob("*.ndjson.gz"))


def test_verify_counts_true_after_clean_compaction(tmp_path: Path):
    """The independent re-count agrees when nothing went wrong (happy path)."""
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)
    assert verify_counts(tmp_path, DAY) is True


def test_verify_counts_false_when_source_corrupted(tmp_path: Path):
    """A corrupt source fails the re-count closed, rather than crashing."""
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)

    (tmp_path / DAY / "00.ndjson.gz").write_bytes(b"this is not a gzip stream")

    assert verify_counts(tmp_path, DAY) is False


def test_verification_failure_keeps_raw_and_raises(tmp_path: Path):
    """(a) Verification failure → nothing deleted + VerificationError raised.

    With ``keep_raw_days=0`` the grace window is open, so verification is the
    only gate standing between the raw files and deletion — and it must fail.
    """
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)
    before = raw_files(tmp_path, DAY)

    (tmp_path / DAY / "00.ndjson.gz").write_bytes(b"corrupt")

    with pytest.raises(VerificationError):
        delete_raw_day(tmp_path, DAY, keep_raw_days=0, now=NOW)

    # Nothing was deleted: the raw tier is the safe copy and must survive.
    assert raw_files(tmp_path, DAY) == before
    assert (tmp_path / "parquet" / f"date={DAY}").is_dir()


def test_fresh_parquet_not_deleted_during_grace(tmp_path: Path):
    """(b) A newly-published Parquet is inside the grace window → kept raw."""
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)

    # mtime == NOW → age 0, well inside a 7-day grace window.
    os.utime(tmp_path / "parquet" / f"date={DAY}", (NOW_EPOCH, NOW_EPOCH))

    deleted = delete_raw_day(tmp_path, DAY, keep_raw_days=7, now=NOW)

    assert deleted == ()
    assert raw_files(tmp_path, DAY) == ["00.ndjson.gz", "03.ndjson.gz"]


def test_old_parquet_deleted_after_grace(tmp_path: Path):
    """(b) Once the Parquet is older than the grace window, raw is deleted."""
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)

    backdate_dir(tmp_path / "parquet" / f"date={DAY}", 8)  # 8 days > 7-day grace

    deleted = delete_raw_day(tmp_path, DAY, keep_raw_days=7, now=NOW)

    assert len(deleted) == 2
    assert raw_files(tmp_path, DAY) == []
    # The Parquet survives — only the raw tier goes.
    assert (tmp_path / "parquet" / f"date={DAY}").is_dir()


def test_delete_removes_exactly_that_days_files(tmp_path: Path):
    """(c) Deleting one day touches only that day's hourly files, nothing else."""
    other_day = "2026-10-21"
    build_day(tmp_path, DAY, {"00": [FULL_LINE]})
    build_day(tmp_path, other_day, {"00": [NULL_LINE]})
    compact_day(tmp_path, DAY)
    compact_day(tmp_path, other_day)

    # Age both outputs past the grace window, but delete only DAY.
    backdate_dir(tmp_path / "parquet" / f"date={DAY}", 8)
    backdate_dir(tmp_path / "parquet" / f"date={other_day}", 8)

    deleted = delete_raw_day(tmp_path, DAY, keep_raw_days=7, now=NOW)

    assert [Path(p).name for p in deleted] == ["00.ndjson.gz"]
    assert raw_files(tmp_path, DAY) == []
    # The other day and both Parquet outputs are untouched.
    assert raw_files(tmp_path, other_day) == ["00.ndjson.gz"]
    assert (tmp_path / "parquet" / f"date={DAY}").is_dir()
    assert (tmp_path / "parquet" / f"date={other_day}").is_dir()


def test_rerun_after_success_is_noop(tmp_path: Path):
    """(d) Deleting again after success is an idempotent no-op."""
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)
    backdate_dir(tmp_path / "parquet" / f"date={DAY}", 8)

    first = delete_raw_day(tmp_path, DAY, keep_raw_days=7, now=NOW)
    assert len(first) == 2

    second = delete_raw_day(tmp_path, DAY, keep_raw_days=7, now=NOW)
    assert second == ()


def test_keep_raw_days_zero_deletes_immediately(tmp_path: Path):
    """``keep_raw_days=0`` skips the grace window entirely."""
    _, _ = make_two_hour_day(tmp_path)
    compact_day(tmp_path, DAY)

    deleted = delete_raw_day(tmp_path, DAY, keep_raw_days=0, now=NOW)

    assert len(deleted) == 2
    assert raw_files(tmp_path, DAY) == []


def test_delete_noop_without_parquet_output(tmp_path: Path):
    """No Parquet → nothing was verified → raw stays (defensive no-op)."""
    build_day(tmp_path, DAY, {"00": [FULL_LINE]})

    assert delete_raw_day(tmp_path, DAY, keep_raw_days=0, now=NOW) == ()
    assert raw_files(tmp_path, DAY) == ["00.ndjson.gz"]
