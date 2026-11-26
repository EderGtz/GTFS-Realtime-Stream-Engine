"""Tests for retention.prune_parquet_days.

Each test fabricates a fake archive tree under ``tmp_path`` (raw day dirs plus
``parquet/date=YYYY-MM-DD`` output dirs) and asserts exactly which compacted
days are deleted. They cover the age boundary (a day is pruned the moment it
turns ``keep_days`` old, measured from 00:00 UTC), the disabled state
(``keep_days <= 0`` keeps everything), robustness against non-date entries,
the missing-root no-op, and — critically — that the raw tier is never touched.
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from retention import prune_parquet_days

# Fixed reference clock: 2026-10-23 12:00 UTC. With keep_days=3 the cutoff is
# 2026-10-20 12:00, so:
#   2026-10-23  age 12h       -> keep
#   2026-10-22  age 36h       -> keep
#   2026-10-21  age 2d 12h    -> keep
#   2026-10-20  age 3d 12h    -> PRUNE (day_start <= cutoff)
#   2026-10-19  age 4d 12h    -> PRUNE
NOW = datetime(2026, 10, 23, 12, 0, 0, tzinfo=UTC)
KEEP_DAYS = 3


def make_tree(
    root: Path, parquet_days: Sequence[str], raw_days: Sequence[str] = ()
) -> None:
    """Create parquet date dirs (with a dummy parquet file) and raw day dirs."""
    for day in parquet_days:
        day_dir = root / "parquet" / f"date={day}"
        day_dir.mkdir(parents=True)
        (day_dir / "part-0.parquet").write_bytes(b"fake")
    for day in raw_days:
        raw_dir = root / day
        raw_dir.mkdir(parents=True)
        (raw_dir / "00.ndjson.gz").write_bytes(b"fake")


def listed_days(root: Path) -> list[str]:
    parquet_root = root / "parquet"
    if not parquet_root.is_dir():
        return []
    return sorted(
        entry.name[len("date=") :]
        for entry in parquet_root.iterdir()
        if entry.is_dir() and entry.name.startswith("date=")
    )


def test_prunes_only_days_past_the_window(tmp_path: Path) -> None:
    make_tree(
        tmp_path,
        ["2026-10-23", "2026-10-22", "2026-10-21", "2026-10-20", "2026-10-19"],
    )

    pruned = prune_parquet_days(tmp_path, KEEP_DAYS, now=NOW)

    assert pruned == ("2026-10-19", "2026-10-20")
    assert listed_days(tmp_path) == ["2026-10-21", "2026-10-22", "2026-10-23"]


def test_day_is_pruned_the_moment_it_turns_keep_days_old(tmp_path: Path) -> None:
    # now == 2026-10-23 00:00 -> cutoff == 2026-10-20 00:00: the 2026-10-20
    # dir is exactly 3 days old and must be pruned (day_start <= cutoff).
    make_tree(tmp_path, ["2026-10-20", "2026-10-21"])
    now = datetime(2026, 10, 23, 0, 0, 0, tzinfo=UTC)

    pruned = prune_parquet_days(tmp_path, KEEP_DAYS, now=now)

    assert pruned == ("2026-10-20",)
    assert listed_days(tmp_path) == ["2026-10-21"]


def test_zero_or_negative_keep_days_disables_retention(tmp_path: Path) -> None:
    make_tree(tmp_path, ["2026-10-01", "2026-09-01"])

    assert prune_parquet_days(tmp_path, 0, now=NOW) == ()
    assert prune_parquet_days(tmp_path, -5, now=NOW) == ()
    assert listed_days(tmp_path) == ["2026-09-01", "2026-10-01"]


def test_raw_day_dirs_are_never_touched(tmp_path: Path) -> None:
    # The same old day exists in BOTH tiers: pruning its parquet output must
    # leave the raw files (the verify-then-delete sweep's business) alone.
    make_tree(tmp_path, ["2026-10-19"], raw_days=["2026-10-19"])

    pruned = prune_parquet_days(tmp_path, KEEP_DAYS, now=NOW)

    assert pruned == ("2026-10-19",)
    assert (tmp_path / "2026-10-19" / "00.ndjson.gz").exists()


def test_non_date_entries_under_parquet_are_ignored(tmp_path: Path) -> None:
    make_tree(tmp_path, ["2026-10-19"])
    stray_dir = tmp_path / "parquet" / "date=not-a-date"
    stray_dir.mkdir()
    (stray_dir / "part-0.parquet").write_bytes(b"fake")
    (tmp_path / "parquet" / "README.txt").write_text("not a day")

    pruned = prune_parquet_days(tmp_path, KEEP_DAYS, now=NOW)

    assert pruned == ("2026-10-19",)
    assert stray_dir.exists()
    assert (tmp_path / "parquet" / "README.txt").exists()


def test_missing_roots_are_no_ops(tmp_path: Path) -> None:
    assert prune_parquet_days(tmp_path, KEEP_DAYS, now=NOW) == ()
    assert prune_parquet_days(tmp_path / "does-not-exist", KEEP_DAYS, now=NOW) == ()


def test_naive_now_is_treated_as_utc(tmp_path: Path) -> None:
    make_tree(tmp_path, ["2026-10-20"])

    pruned = prune_parquet_days(
        tmp_path, KEEP_DAYS, now=datetime(2026, 10, 23, 12, 0, 0)
    )

    assert pruned == ("2026-10-20",)
