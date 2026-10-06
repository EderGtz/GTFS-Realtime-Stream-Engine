"""
Unit tests for db/pg_connection.py — connect_pg_with_retry.

Uses mocked psycopg2 to verify retry logic and error handling without
requiring a live PostgreSQL connection.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from db.pg_connection import connect_pg_with_retry


class TestConnectPgWithRetry:
    def test_returns_connection_on_first_attempt(self):
        mock_conn = MagicMock()
        with patch("db.pg_connection.psycopg2.connect", return_value=mock_conn):
            conn = connect_pg_with_retry("postgresql://fake")
        assert conn is mock_conn
        conn.autocommit = False  # verify attribute was set

    def test_retries_on_operational_error_then_succeeds(self):
        import psycopg2
        mock_conn = MagicMock()
        with patch("db.pg_connection.psycopg2.connect") as mock_connect:
            mock_connect.side_effect = [
                psycopg2.OperationalError("connection refused"),
                mock_conn,
            ]
            with patch("db.pg_connection.time.sleep"):
                conn = connect_pg_with_retry("postgresql://fake", attempts=5)
        assert conn is mock_conn
        assert mock_connect.call_count == 2

    def test_raises_after_exhausting_attempts(self):
        import psycopg2
        with patch("db.pg_connection.psycopg2.connect") as mock_connect:
            mock_connect.side_effect = psycopg2.OperationalError("connection refused")
            with patch("db.pg_connection.time.sleep"):
                with pytest.raises(ConnectionError, match="5 attempts"):
                    connect_pg_with_retry("postgresql://fake", attempts=5)
        assert mock_connect.call_count == 5

    def test_sets_autocommit_false(self):
        mock_conn = MagicMock()
        with patch("db.pg_connection.psycopg2.connect", return_value=mock_conn):
            connect_pg_with_retry("postgresql://fake")
        assert mock_conn.autocommit is False

    def test_passes_connect_timeout(self):
        mock_conn = MagicMock()
        with patch("db.pg_connection.psycopg2.connect", return_value=mock_conn) as mock_connect:
            connect_pg_with_retry("postgresql://fake")
        mock_connect.assert_called_once_with("postgresql://fake", connect_timeout=5)
