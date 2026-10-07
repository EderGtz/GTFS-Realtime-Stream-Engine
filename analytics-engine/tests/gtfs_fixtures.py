"""
Helpers for the curated real-world GTFS fixtures in tests/fixtures/gtfs/.

The fixture archive lives at the repo root, documented in tests/fixtures/gtfs/README.md.
This module knows how to find, extract, and read it; conftest.py wraps extraction
in a pytest fixture and test_gtfs_fixtures.py asserts the loader handles each
fixture's quirks gracefully.
"""

from __future__ import annotations

import csv
import zipfile
from pathlib import Path

# tests/gtfs_fixtures.py -> parents[2] == root
FIXTURES_DIR = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "gtfs"

# Repo budget for fixture archives (also enforced by curate_fixtures.py).
MAX_FIXTURE_BYTES = 1_000_000

ALL_FIXTURES = (
    "mbta-2019-07-25",
    "wmata-2026-04-29",
    "bart-2010",
    "duplicate-trip-ids",
    "orphan-stop-times",
)


def extract(name: str, dest: Path) -> Path:
    """Extract fixture `name` (a .zip under FIXTURES_DIR) into `dest`/`name`
    and return the extracted directory, ready for GtfsStaticData(gtfs_dir)."""
    archive = FIXTURES_DIR / f"{name}.zip"
    if not archive.exists():
        raise FileNotFoundError(
            f"missing GTFS fixture {archive} -- see tests/fixtures/gtfs/README.md"
        )
    feed_dir = dest / name
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(feed_dir)
    return feed_dir


def read_rows(gtfs_dir: Path, filename: str) -> list[dict[str, str]]:
    """Read one .txt file of an extracted fixture as raw CSV rows (strings),
    for assertions that need the feed's original content rather than the
    loader's parsed lookups."""
    with (gtfs_dir / filename).open(encoding="utf-8-sig", newline="") as f:
        return [
            {k: (v or "") for k, v in row.items() if k is not None}
            for row in csv.DictReader(f)
        ]
