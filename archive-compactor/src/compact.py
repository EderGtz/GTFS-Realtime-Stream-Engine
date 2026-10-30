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
from datetime import UTC, datetime
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


def _parquet_dir(archive_dir: Path, day: str) -> Path:
    """The Hive-partition output dir for one day: <archive>/parquet/date=<day>."""
    return archive_dir / PARQUET_DIR_NAME / f"{PARQUET_DIR_PREFIX}{day}"


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
    output_dir = _parquet_dir(archive_dir, day)

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


# ─── Verify-then-delete ──────────────────────────────────────────────────────
#
# Task 11: the raw tier is only ever deleted *after* two independent gates pass
# (grace window, then row-count verification). The order matters: grace is
# checked first because there is nothing to do until the window closes, and
# verification — which re-reads the whole day from disk — is only worth the cost
# when deletion is actually due.


class VerificationError(RuntimeError):
    """A day failed its row-count verification, so its raw files were kept.

    Raised by :func:`delete_raw_day` instead of a result flag: a failure here is
    a real problem the caller must act on. Subclassing RuntimeError (no bespoke
    hierarchy) keeps the exception banal — main.py catches it, logs it, and maps
    it to a non-zero ``--once`` exit.
    """


def _count_source_lines(archive_dir: Path, day: str) -> int:
    """Re-count the raw lines across ``<day>``'s gz files, fresh from disk.

    This is independent of the read that happened during compaction: deletion
    routinely runs days later in a different process, so it must never trust the
    counts the compaction run held in memory.
    """
    read_sql = _RAW_LINES_READ_SQL.format(
        source=_sql_str(str(archive_dir / day / "*.ndjson.gz"))
    )
    con = duckdb.connect()
    try:
        return con.execute(f"SELECT count(*) FROM ({read_sql}) t").fetchone()[0]
    finally:
        con.close()


def _count_parquet_rows(output_dir: Path) -> int:
    """Re-count the rows in the day's published Parquet, fresh from disk."""
    con = duckdb.connect()
    try:
        return con.execute(
            "SELECT count(*) FROM read_parquet("
            + _sql_str(str(output_dir / "*.parquet"))
            + ")"
        ).fetchone()[0]
    finally:
        con.close()


def verify_counts(archive_dir: Path, day: str) -> bool:
    """True when the day's Parquet rows equal its raw lines, re-counted on disk.

    WHY re-count over a marker file: a ``compacted.ok`` marker is one more piece
    of state to keep consistent across crashes, retries and manual cleanups, and
    it can drift from reality (marker present, Parquet truncated). Re-counting
    both representations *is* the ground truth, with nothing to desynchronize.
    Fail-closed on either side: a source that can't be read (corrupt/truncated
    .gz) reports unverified rather than risking the only copy of the data.
    """
    try:
        source_lines = _count_source_lines(archive_dir, day)
    except duckdb.Error:
        return False
    try:
        parquet_rows = _count_parquet_rows(_parquet_dir(archive_dir, day))
    except duckdb.Error:
        return False
    return source_lines == parquet_rows


def delete_raw_day(
    archive_dir: Path,
    day: str,
    *,
    keep_raw_days: int,
    now: datetime | None = None,
) -> tuple[str, ...]:
    """Verify-then-delete one day's raw ``HH.ndjson.gz`` files.

    Returns the paths actually deleted (empty means "nothing deleted"). The raw
    files are unlinked only when **both** hold:

    1. the grace period elapsed — the Parquet output is at least
       ``keep_raw_days`` days old (``0`` deletes immediately after verification);
    2. verification succeeded — a fresh re-count shows Parquet rows == raw lines.

    A verification failure raises :class:`VerificationError` *without* deleting
    anything (the raw tier is the safe copy and stays intact); a missing output
    dir or already-deleted raw files are plain no-ops, which is what makes
    re-runs idempotent.
    """
    now = now or datetime.now(UTC)
    raw_files = sorted((archive_dir / day).glob("*.ndjson.gz"))
    output_dir = _parquet_dir(archive_dir, day)

    # A previous run already finished the deletion → idempotent no-op.
    if not raw_files:
        return ()

    # No Parquet output → nothing was ever verified, so never delete raw.
    # Eligibility normally prevents reaching this point; the guard keeps the
    # function fail-safe if it is called by hand.
    if not output_dir.is_dir():
        return ()

    # Grace first: before the window closes there is nothing to delete, so skip
    # the (read-heavy) verification rather than re-reading the day every tick.
    if not _grace_elapsed(output_dir.stat().st_mtime, keep_raw_days, now):
        return ()

    if not verify_counts(archive_dir, day):
        raise VerificationError(
            f"verification failed for {day}: Parquet rows do not match raw "
            f"lines; kept raw files for re-inspection"
        )

    deleted: list[str] = []
    for path in raw_files:
        path.unlink()
        deleted.append(str(path))
    return tuple(deleted)


def _grace_elapsed(output_mtime: float, keep_raw_days: int, now: datetime) -> bool:
    """True when the Parquet output is at least ``keep_raw_days`` days old.

    Mtime-based and coarse to whole days: the grace window exists so a human can
    re-run the compactor and eyeball the Parquet while the raw copy is still
    present, so day-precision is plenty (and mtimes are the "manual lever" the
    plan documents for a restored/copied tree). ``0`` (or negative) means
    "immediately": delete as soon as verification has passed.
    """
    if keep_raw_days <= 0:
        return True
    age_seconds = now.timestamp() - output_mtime
    return age_seconds >= keep_raw_days * 24 * 3600
