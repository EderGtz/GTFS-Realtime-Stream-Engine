"""Day-eligibility rules for the archive compactor.

Given the on-disk archive tree and the current time, decide which ``YYYY-MM-DD`` 
days are safe to fold into Parquet. No file writes, no clock access (time is 
passed in), no environment and no database reads.

A day directory is eligible when all these three gates pass:

1. Age: the day is old enough that the live Go writer can no longer touch
   it. The writer only ever appends to the current hour and gzips a file once
   its hour closes, so a full day back is guaranteed closed after 48h.
2. Gzip: every hourly file in the day is already ``.ndjson.gz``, i.e. there
   are no plain ``.ndjson`` leftovers. Plain files exist only transiently (active
   hour, or a crash the next startup's finalizeStale recovers), so a leftover
   means the day is still being written or recovered, and we skip it.
3. Idempotency: the day's Parquet output already exists, meaning we already
   compacted it; skipping keeps re-runs cheap no-ops.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

# Minimum age (measured from a day's 00:00 UTC) before it may be compacted.
# 48h is the value from the Phase 2 design table; it guarantees "yesterday" is
# never eligible (at most 24h back) while "two days ago" always is (at least 48h
# back).
MIN_AGE = timedelta(hours=48)

# The Parquet output lives inside the archive root under these names, one
# subdir per compacted day. The Hive-style `date=YYYY-MM-DD` prefix lets
# any data wrangling and analysis tool like DuckDB/pandas/Polars push 
# the date predicate down to a directory listing.
PARQUET_DIR_NAME = "parquet"
PARQUET_DIR_PREFIX = "date="

# Raw hourly files are named "HH.ndjson" while plain (active) and "HH.ndjson.gz"
# once closed. A plain file disables a day; see _has_plain_ndjson for the nuance
# around suffixes.
RAW_PLAIN_SUFFIX = ".ndjson"


def eligible_days(root: Path, now: datetime) -> list[str]:
    """Return the sorted list of ``YYYY-MM-DD`` day dirs safe to compact.

    ``root`` is the archive root (the Go consumer's ARCHIVE_DIR):

        root/YYYY-MM-DD/HH.ndjson.gz          raw tier
        root/parquet/date=YYYY-MM-DD/...      compacted tier

    ``now`` is the current moment; it may be any timezone-aware datetime, and a
    naive datetime is treated as UTC. A missing or empty ``root`` returns ``[]``
    so the compactor's daily tick is a harmless no-op on a fresh install (nothing 
    to compact yet).

    The three gates are decomposed into the private helpers below so each is
    independently readable and the truth of the module docstring doesn't depend
    on reading one long loop.
    """
    root = Path(root)
    if not root.is_dir():
        return []

    now = _as_utc(now)
    eligible: list[str] = []
    for day in _day_directories(root):
        day_dir = root / day
        if not _old_enough(day, now):
            continue
        if _has_plain_ndjson(day_dir):
            continue
        if _already_compacted(root, day):
            continue
        eligible.append(day)

    # YYYY-MM-DD sorts lexicographically == chronologically, which is the order
    # the compactor should process days in (oldest first) and the order tests and
    # callers can rely on.
    return sorted(eligible)


def _day_directories(root: Path) -> list[str]:
    """Return immediate subdirectories whose name parses strictly as a date.

    Only ``YYYY-MM-DD`` dirs qualify; anything else (like the ``parquet/`` output
    root, a stray ``.tmp/``, any unrelated dir) is ignored by construction
    because its name will not parse as a date. This is also why a bare
    ``root/parquet/`` is never mistaken for a day.
    """
    days: list[str] = []
    try:
        entries = root.iterdir()
    except OSError:
        # Unreadable root is treated like a missing root: a no-op, not a fatal
        # error. The compactor tick logs and retries next cycle instead of
        # crashing out on a transient permission/IO hiccup.
        return []

    for entry in entries:
        if not entry.is_dir():
            continue
        day = entry.name
        try:
            datetime.strptime(day, "%Y-%m-%d")
        except ValueError:
            continue
        days.append(day)
    return days


def _as_utc(dt: datetime) -> datetime:
    """Normalize ``dt`` to timezone-aware UTC so later subtractions are defined.

    The compactor itself always passes an aware UTC ``now``; this fallback merely
    makes naive datetimes (ad-hoc scripts, some tests) forgiving rather than
    raising or silently comparing aware-vs-naive.
    """
    if dt.tzinfo is None or dt.utcoffset() is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _old_enough(day: str, now: datetime) -> bool:
    """True when the day's 00:00 UTC is at least ``MIN_AGE`` before ``now``.

    Measuring from midnight (rather than, say, the day's end) is deliberate: it is
    the loosest age check that still excludes "yesterday" at any point during
    today.
    """
    day_start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=UTC)
    return now - day_start >= MIN_AGE


def _has_plain_ndjson(day_dir: Path) -> bool:
    """True when any hourly file in the day is still a plain ``.ndjson``.

    Only the exact ``.ndjson`` suffix is checked: ``HH.ndjson.gz`` has suffix
    ``.gz`` and is not a match, and transient ``.tmp`` files are ignored too.
    An unreadable day dir is treated as "not yet safe" (skip it) rather than
    risking a compaction over a directory we couldn't fully inspect.
    """
    try:
        for path in day_dir.iterdir():
            if path.is_file() and path.suffix == RAW_PLAIN_SUFFIX:
                return True
    except OSError:
        return True
    return False


def _already_compacted(root: Path, day: str) -> bool:
    """True when the day's Parquet output dir already exists.

    Existence of the output dir is the "already done" marker — no side-channel
    marker file — keeping the tree self-describing and re-runs cheap no-ops. Note
    a half-written dir from a crashed run would block recompaction until examined;
    that's acceptable because deletion is verify-then-delete, so a partial run
    never removed raw files in the first place.
    """
    output = root / PARQUET_DIR_NAME / f"{PARQUET_DIR_PREFIX}{day}"
    return output.exists()
