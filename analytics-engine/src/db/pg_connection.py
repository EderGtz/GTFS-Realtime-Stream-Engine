from __future__ import annotations

import time

import psycopg2
from psycopg2.extensions import connection as PgConnection

from utils.logger import get_logger

logger = get_logger("analytics-engine.pg_connection")


def connect_pg_with_retry(
    dsn: str,
    attempts: int = 5,
    delay_seconds: float = 3.0,
) -> PgConnection:
    """
    Args:
        dsn: PostgreSQL connection string (e.g. "postgresql://user:pass@host:5432/db")
        attempts: Max connection attempts before raising.
        delay_seconds: Wait between attempts.

    Returns:
        An open psycopg2 connection.
    """
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            conn = psycopg2.connect(dsn, connect_timeout=5)
            conn.autocommit = False
            logger.info("Connected to PostgreSQL (attempt %d)", attempt)
            return conn
        except psycopg2.OperationalError as err:
            last_error = err
            if attempt == attempts:
                break
            logger.warning(
                "PostgreSQL connect failed (attempt %d/%d), retrying...",
                attempt, attempts,
            )
            time.sleep(delay_seconds)

    raise ConnectionError(
        f"Could not connect to PostgreSQL after {attempts} attempts"
    ) from last_error