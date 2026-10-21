"""Contract test: the PostgreSQL side of the history endpoint.

route_hourly_stats (pg_schema.py) and the HourlyStats row type must match the
shared contract at tests/contracts/route_hourly_stats.json — the same file the
API side (ingestion-service/tests/api/routeHistoryContract.test.ts) validates
its SQL and response shape against. Catches schema/API drift like a renamed
or missing column on either side.
"""

from __future__ import annotations

import dataclasses
import json
import re
from pathlib import Path

from db.pg_schema import ROUTE_HOURLY_STATS_DDL, HourlyStats

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT = json.loads(
    (REPO_ROOT / "tests" / "contracts" / "route_hourly_stats.json").read_text()
)


def ddl_columns(ddl: str) -> list[str]:
    """Column names from the CREATE TABLE body (typed lines only, so the
    PRIMARY KEY clause is not mistaken for a column)."""
    return re.findall(
        r"^\s{4}(\w+)\s+(?:TEXT|TIMESTAMPTZ|DOUBLE PRECISION|INTEGER)",
        ddl,
        re.MULTILINE,
    )


def test_ddl_columns_match_contract():
    assert ddl_columns(ROUTE_HOURLY_STATS_DDL) == CONTRACT["columns"]


def test_hourly_stats_row_type_matches_contract():
    names = [f.name for f in dataclasses.fields(HourlyStats)]
    assert names == CONTRACT["columns"]
