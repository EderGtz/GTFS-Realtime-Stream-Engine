"""Tests for eligibility.eligible_days.

Each test fabricates a fake ``data/archive`` tree under
``tmp_path`` and asserts which ``YYYY-MM-DD`` days the rules select. They cover
every gate in the Phase 2 eligibility spec (age, gzip, idempotency) plus the
no-op-on-missing/empty-tree requirement and a couple of boundary/robustness cases
(non-date dirs, naive ``now``, the exact 48h edge).
"""

from datetime import UTC, datetime
from pathlib import Path

from eligibility import eligible_days

# Fixed reference clock: 2026-10-23 12:00 UTC. Relative ages of the test days:
#   2026-10-23  today          -> 00:00 is 12h  old  (< 48h, excluded)
#   2026-10-22  yesterday      -> 00:00 is 36h  old  (< 48h, excluded)
#   2026-10-21  two days ago   -> 00:00 is 60h  old  (>= 48h, included)
#   2026-10-20  three days ago -> 00:00 is 84h old  (>= 48h, included)
NOW = datetime(2026, 10, 23, 12, 0, 0, tzinfo=UTC)

TODAY = "2026-10-23"
YESTERDAY = "2026-10-22"
TWO_DAYS_AGO = "2026-10-21"
THREE_DAYS_AGO = "2026-10-20"

# A "clean" day: nothing but gzipped hourly files. A representative subset is
# enough — eligibility only requires the *absence* of plain .ndjson files, since
# a day may legitimately hold fewer than 24 files (the Go consumer was down part
# of the day) and that is still valid archive data.
CLEAN_FILES = ["00.ndjson.gz", "12.ndjson.gz", "23.ndjson.gz"]


def make_day(root: Path, day: str, files: list[str] | None = None) -> Path:
    """Create ``root/<day>/`` populated with ``files`` (default: a clean day).

    File *contents* are irrelevant to eligibility, so empty files suffice — only
    names and suffixes matter to the rules under test.
    """
    day_dir = root / day
    day_dir.mkdir(parents=True, exist_ok=True)
    for name in CLEAN_FILES if files is None else files:
        (day_dir / name).write_bytes(b"")
    return day_dir


def make_parquet_output(root: Path, day: str) -> Path:
    """Create the Parquet output dir for ``day`` that compaction would produce."""
    out = root / "parquet" / f"date={day}"
    out.mkdir(parents=True, exist_ok=True)
    return out


# ── Age gate ────────────────────────────────────────────────────────────────


def test_today_excluded(tmp_path: Path):
    """The current day is far too young to be safely closed and compacted."""
    make_day(tmp_path, TODAY, CLEAN_FILES)
    assert eligible_days(tmp_path, NOW) == []


def test_yesterday_excluded(tmp_path: Path):
    """At 36h old, yesterday still fails the 48h minimum-age gate."""
    make_day(tmp_path, YESTERDAY, CLEAN_FILES)
    assert eligible_days(tmp_path, NOW) == []


def test_two_day_old_clean_day_included(tmp_path: Path):
    """A clean day 60h old is the first one old enough to compact."""
    make_day(tmp_path, TWO_DAYS_AGO, CLEAN_FILES)
    assert eligible_days(tmp_path, NOW) == [TWO_DAYS_AGO]


def test_exactly_48h_old_is_eligible_boundary(tmp_path: Path):
    """The age gate is inclusive: a day whose 00:00 is exactly 48h back passes."""
    midnight_now = datetime(2026, 10, 23, 0, 0, 0, tzinfo=UTC)
    make_day(
        tmp_path, TWO_DAYS_AGO, CLEAN_FILES
    )  # 10-21 00:00 == 48h before MIDNIGHT_NOW
    assert eligible_days(tmp_path, midnight_now) == [TWO_DAYS_AGO]


# ── Gzip gate ────────────────────────────────────────────────────────────────


def test_two_day_old_with_plain_file_excluded(tmp_path: Path):
    """A single leftover plain .ndjson disqualifies the whole day.

    The Go writer leaves the active hour plain and gzips it only on close; a
    plain file here means the day is still being recovered from a crash.
    """
    make_day(tmp_path, TWO_DAYS_AGO, CLEAN_FILES + ["05.ndjson"])
    assert eligible_days(tmp_path, NOW) == []


def test_two_day_old_with_transient_tmp_ignored(tmp_path: Path):
    """Transient .tmp artifacts (crash mid-gzip) do not disqualify the day."""
    make_day(tmp_path, TWO_DAYS_AGO, CLEAN_FILES + ["05.ndjson.gz.tmp"])
    assert eligible_days(tmp_path, NOW) == [TWO_DAYS_AGO]


# ── Idempotency gate ─────────────────────────────────────────────────────────


def test_two_day_old_with_existing_parquet_excluded(tmp_path: Path):
    """An existing Parquet output means we already compacted this day."""
    make_day(tmp_path, TWO_DAYS_AGO, CLEAN_FILES)
    make_parquet_output(tmp_path, TWO_DAYS_AGO)
    assert eligible_days(tmp_path, NOW) == []


# ── No-op / robustness ───────────────────────────────────────────────────────


def test_missing_root_is_noop(tmp_path: Path):
    """A nonexistent root is a no-op, not an error (fresh install)."""
    assert eligible_days(tmp_path / "nope", NOW) == []


def test_empty_root_is_noop(tmp_path: Path):
    """A root with no day directories yields nothing."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    assert eligible_days(tmp_path, NOW) == []


def test_ignores_non_date_directories(tmp_path: Path):
    """Only YYYY-MM-DD dirs are considered; parquet/ and misc dirs are ignored."""
    make_day(tmp_path, TWO_DAYS_AGO, CLEAN_FILES)
    (tmp_path / "parquet").mkdir()  # the output root itself, not a day
    (tmp_path / "notes").mkdir()  # unrelated dir
    (tmp_path / "20-10-2026").mkdir()  # wrong date format
    assert eligible_days(tmp_path, NOW) == [TWO_DAYS_AGO]


def test_naive_now_treated_as_utc(tmp_path: Path):
    """A naive datetime is interpreted as UTC rather than raising."""
    make_day(tmp_path, TWO_DAYS_AGO, CLEAN_FILES)
    naive_now = datetime(2026, 10, 23, 12, 0, 0)  # no tzinfo
    assert eligible_days(tmp_path, naive_now) == [TWO_DAYS_AGO]


def test_returns_sorted_multiple_days(tmp_path: Path):
    """Multiple eligible days come back sorted, oldest first (chronological)."""
    make_day(tmp_path, TWO_DAYS_AGO, CLEAN_FILES)
    make_day(tmp_path, THREE_DAYS_AGO, CLEAN_FILES)
    # Creation order and directory listing order must not leak through.
    assert eligible_days(tmp_path, NOW) == [THREE_DAYS_AGO, TWO_DAYS_AGO]
