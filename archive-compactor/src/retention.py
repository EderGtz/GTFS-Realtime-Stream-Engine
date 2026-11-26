"""Parquet retention: bound the compacted tier's disk growth.

Compaction (compact.py) is the archive's final form, but nothing deleted it:
the compacted tier grew at ~90 MB/day on the production VPS and the
2026-11-01 disk-pressure incident closed with this policy explicitly open.
``prune_parquet_days`` closes that gap — each daily pass deletes
``parquet/date=YYYY-MM-DD`` directories once they age past the configured
retention window, so the tier plateaus instead of filling the disk.

Retention is a deletion policy, not a backup. If the archive must outlive the
retention window, pruned months should be offloaded to object storage first
(the long-standing recommendation from the same incident).

Same contract as eligibility.py: deletion-only filesystem access, the clock is
passed in, no environment reads. Deletion is whole-directory (``shutil.rmtree``)
because a day dir is written once and never rewritten; re-runs are idempotent
because a deleted day is simply gone from the listing.
"""

from __future__ import annotations

import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from eligibility import PARQUET_DIR_NAME, PARQUET_DIR_PREFIX


def prune_parquet_days(
    root: Path,
    keep_days: int,
    now: datetime | None = None,
) -> tuple[str, ...]:
    """Delete compacted day dirs that are ``keep_days`` days old.

    Returns the deleted day names, oldest first (empty tuple = nothing to
    do). Age is measured from a day's 00:00 UTC — the same clock
    eligibility.py uses — so ``keep_days=30`` keeps the newest ~30 day dirs
    and a day is pruned as soon as it turns 30 days old.

    ``keep_days <= 0`` disables retention (keep forever). This is deliberate:
    an unset or zeroed knob must never read as "delete everything".

    Anything under ``parquet/`` that is not a ``date=YYYY-MM-DD`` directory is
    ignored, and a missing root is a no-op — same forgiving shape as
    ``eligible_days``.
    """
    if keep_days <= 0:
        return ()

    root = Path(root)
    now = _as_utc(now or datetime.now(UTC))
    cutoff = now - timedelta(days=keep_days)

    pruned: list[str] = []
    for entry in _date_dirs(root):
        day = entry.name[len(PARQUET_DIR_PREFIX) :]
        day_start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=UTC)
        if day_start <= cutoff:
            shutil.rmtree(entry)
            pruned.append(day)

    # YYYY-MM-DD within the date= prefix sorts lexicographically == oldest
    # first, matching every other day listing in this package.
    return tuple(sorted(pruned))


def _date_dirs(root: Path) -> list[Path]:
    """The ``parquet/date=YYYY-MM-DD`` dirs whose name parses as a date."""
    parquet_root = root / PARQUET_DIR_NAME
    if not parquet_root.is_dir():
        return []
    dirs: list[Path] = []
    try:
        entries = parquet_root.iterdir()
    except OSError:
        return []
    for entry in entries:
        if not entry.is_dir() or not entry.name.startswith(PARQUET_DIR_PREFIX):
            continue
        try:
            datetime.strptime(entry.name[len(PARQUET_DIR_PREFIX) :], "%Y-%m-%d")
        except ValueError:
            continue
        dirs.append(entry)
    return dirs


def _as_utc(dt: datetime) -> datetime:
    """Normalize ``dt`` to timezone-aware UTC (forgiving on naive input)."""
    if dt.tzinfo is None or dt.utcoffset() is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)
