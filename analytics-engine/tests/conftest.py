"""
Shared pytest fixtures for the analytics-engine test suite.

`gtfs_fixture` extracts one of the GTFS feeds from
tests/fixtures/gtfs/ into tmp_path so tests can point
GtfsStaticData at real feed data. See tests/fixtures/gtfs/README.md 
for what each feed contains.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from gtfs_fixtures import extract


@pytest.fixture
def gtfs_fixture(tmp_path: Path):
    """Factory fixture: gtfs_fixture("mbta-2019-07-25") -> extracted feed dir."""

    def _extract(name: str) -> Path:
        return extract(name, tmp_path)

    return _extract
