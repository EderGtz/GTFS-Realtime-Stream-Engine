"""Compaction core: fold one fully-closed day of NDJSON.gz into zstd Parquet.

raw-first + promoted columns approach:

  * raw:           the exact NDJSON line bytes, so nothing is ever lost and any
                   field that doesn't fit the fixed schema still survives.
  * promoted cols: a fixed, explicit schema derived from raw with DuckDB's
                   JSON path functions, for cheap analytical queries.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

import duckdb

from eligibility import PARQUET_DIR_NAME, PARQUET_DIR_PREFIX

# The delimiter is a control byte (SOH, \x01) that can never appear in a
# JSON.stringify() line since JavaScript escapes every U+0000..U+001F, so the whole
# physical line collapses into a single CSV field: the raw NDJSON line, which is raw 
# byte for byte. Commas would split the line, which is exactly why the delimiter is 
# not the default comma.
#
# One raw line = one row in the temp table. The `WHERE raw <> ''` drops only a
# hypothetical stray blank line (a file ending in '\n' does not produce one on
# its own), and is a cheap correctness net rather than a load-bearing filter.
_RAW_LINES_READ_SQL = """
SELECT raw
FROM read_csv({source}, header = false, columns = {{'raw': 'VARCHAR'}}, delim = chr(1))
WHERE raw <> ''
"""


def _sql_str(value: str) -> str:
    """Return ``value`` as a SQL string literal (single quotes, embedded quotes
    doubled).

    The source glob and the COPY destination are interpolated as literals not
    bound as prepared parameters: DuckDB refuses to prepare DDL/``TO`` clauses
    with ``?``.
    """
    return "'" + value.replace("'", "''") + "'"


def _build_raw_lines_table(con, glob_pattern: str) -> None:
    """Materialize the day's raw lines into an in-memory temp table once.

    Reading into a temp table (rather than a view) means the compressed input is
    decompressed a single time, and both the line count and the COPY below
    consume the in-memory rows, so there is no second pass over the .gz files.
    """
    con.execute(
        "CREATE TEMP TABLE raw_lines AS "
        + _RAW_LINES_READ_SQL.format(source=_sql_str(glob_pattern))
    )


# One expression per promoted column, ordered to match the documented schema
# (docs/archive-consumer.md): agency_id, vehicle_id, trip_id, route_id,
# direction_id, location, timestamp, bearing, speed, current_stop_sequence,
# stop_id, current_status, ingested_at, raw.
_PROMOTED_COLUMNS_SQL = """
    json_extract_string(raw, '$.agency_id')              AS agency_id,
    json_extract_string(raw, '$.vehicle_id')             AS vehicle_id,
    json_extract_string(raw, '$.trip_id')                AS trip_id,
    json_extract_string(raw, '$.route_id')                AS route_id,
    TRY_CAST(json_extract(raw, '$.direction_id') AS BIGINT)
                                                          AS direction_id,
    TRY_CAST(json_extract(raw, '$.location')
             AS STRUCT("type" VARCHAR, coordinates DOUBLE[]))
                                                          AS location,
    TRY_CAST(json_extract_string(raw, '$.timestamp') AS TIMESTAMP)
                                                          AS timestamp,
    TRY_CAST(json_extract(raw, '$.bearing') AS DOUBLE)    AS bearing,
    TRY_CAST(json_extract(raw, '$.speed') AS DOUBLE)      AS speed,
    TRY_CAST(json_extract(raw, '$.current_stop_sequence') AS BIGINT)
                                                          AS current_stop_sequence,
    json_extract_string(raw, '$.stop_id')                 AS stop_id,
    json_extract_string(raw, '$.current_status')          AS current_status,
    TRY_CAST(json_extract_string(raw, '$.ingested_at') AS TIMESTAMP)
                                                          AS ingested_at,
    raw
"""


@dataclass(frozen=True)
class CompactResult:
    """Outcome of compacting one day."""

    # Which day was compacted
    day: str

    # Absolute paths of the source hourly files consumed, oldest hour first.
    source_files: tuple[str, ...]

    # Raw NDJSON lines read
    source_lines: int

    # Rows in the produced Parquet, read back from disk
    parquet_rows: int

    # Published output directory: <archive>/parquet/date=<day>. None when there
    # was nothing to compact (no source files at all).
    output_dir: str | None


def compact_day(archive_dir: Path, day: str) -> CompactResult:
    """Compact one day's ``HH.ndjson.gz`` files into ``parquet/date=<day>/``.

    ``archive_dir`` - raw archive root (the Go consumer's ARCHIVE_DIR)

    ``day`` - ``YYYY-MM-DD`` directory inside ``archive_dir``. The caller (eligibility.py,
    then main.py) is responsible for only passing old, fully-gzipped,
    not-yet-compacted days — this function does the mechanical fold.

    Returns a :class:`CompactResult` with the source/output paths and the two
    row counts. A day with no closed hourly files is *not* an error: it returns
    zero counts and a ``None`` output dir, so an empty tree stays a no-op.
    """
    archive_dir = Path(archive_dir)
    source_files = sorted((archive_dir / day).glob("*.ndjson.gz"))
    output_dir = archive_dir / PARQUET_DIR_NAME / f"{PARQUET_DIR_PREFIX}{day}"

    if not source_files:
        return CompactResult(
            day=day,
            source_files=(),
            source_lines=0,
            parquet_rows=0,
            output_dir=None,
        )

    con = duckdb.connect()

    try:
        glob_pattern = str(archive_dir / day / "*.ndjson.gz")
        _build_raw_lines_table(con, glob_pattern)
        source_lines = con.execute("SELECT count(*) FROM raw_lines").fetchone()[0]

        # Write into a hidden temp dir *under parquet/*, then atomically rename
        # it to the final date=<day> name. A crash mid-write can never publish a
        # half-written partition that a later eligibility pass would mistake for
        # a completed one. os.replace also refuses to overwrite an existing
        # non-empty output dir, so a re-run cannot silently clobber prior work.
        parquet_root = archive_dir / PARQUET_DIR_NAME
        parquet_root.mkdir(parents=True, exist_ok=True)
        tmp_output_dir = Path(
            tempfile.mkdtemp(
                prefix=f".{PARQUET_DIR_PREFIX}{day}.",
                dir=parquet_root,
            )
        )
        try:
            # A single .parquet per compacted day.
            copy_sql = (
                f"COPY (SELECT {_PROMOTED_COLUMNS_SQL} FROM raw_lines) "
                f"TO {_sql_str(str(tmp_output_dir / 'data.parquet'))} "
                f"(FORMAT PARQUET, COMPRESSION ZSTD)"
            )
            con.execute(copy_sql)
            os.replace(tmp_output_dir, output_dir)
        except Exception:
            shutil.rmtree(tmp_output_dir, ignore_errors=True)
            raise

        # Read the *published* output back and count its rows; this number should
        # equal source_lines
        parquet_rows = con.execute(
            "SELECT count(*) FROM read_parquet("
            + _sql_str(str(output_dir / "*.parquet"))
            + ")"
        ).fetchone()[0]
    finally:
        con.close()

    return CompactResult(
        day=day,
        source_files=tuple(str(p) for p in source_files),
        source_lines=source_lines,
        parquet_rows=parquet_rows,
        output_dir=str(output_dir),
    )
