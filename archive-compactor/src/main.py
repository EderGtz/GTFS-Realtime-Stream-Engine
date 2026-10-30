"""Entry point for the archive compactor.

Two modes:

  --once    One pass — compact every eligible day, then verify-then-delete any
            day whose raw files are past their grace period — and exit. The
            process status is non-zero if any day failed (so a scheduled job or
            an operator can react), zero otherwise.
  (default) Loop — run a pass immediately on startup (the design's "once on
            startup"), then sleep until the next ~03:00 UTC and repeat. SIGTERM
            and SIGINT translate into a clean shutdown, the same discipline as
            analytics-engine/src/main.py.

The compactor is file-I/O only: it reads the raw NDJSON.gz tree the Go consumer
writes, folds complete days into Parquet, and (after verification + grace)
removes the raw files it folded.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from datetime import UTC, datetime, timedelta

from compact import VerificationError, compact_day, delete_raw_day
from config import AppConfig
from eligibility import PARQUET_DIR_NAME, PARQUET_DIR_PREFIX, eligible_days

logger = logging.getLogger("archive-compactor")

# The daily run hour, UTC. 03:00 (off-peak)
RUN_HOUR_UTC = 3


def _now() -> datetime:
    """The current instant as a timezone-aware UTC datetime.

    A one-line helper so the two call sites (--once and the loop) read the clock
    identically, and so tests can see there is a single source of "now".
    """
    return datetime.now(UTC)


def _compacted_days(archive_dir) -> list[str]:
    """Days that already have a Parquet output dir (raw-deletion candidates).

    The verify-then-delete sweep must cover days compacted on *earlier* runs too,
    because the grace period (default 7 days) deliberately spans runs: a day
    compacted last week only becomes deletable by this week's pass.
    """
    parquet_root = archive_dir / PARQUET_DIR_NAME
    if not parquet_root.is_dir():
        return []
    days: list[str] = []
    for entry in parquet_root.iterdir():
        if entry.is_dir() and entry.name.startswith(PARQUET_DIR_PREFIX):
            days.append(entry.name[len(PARQUET_DIR_PREFIX) :])
    return sorted(days)


def run_once(config: AppConfig, now: datetime) -> int:
    """One full pass. Returns the number of days that failed (0 == all good)."""
    failures = 0

    # Compact every eligible day: old, fully-gzipped, not-yet-compacted
    for day in eligible_days(config.archive_dir, now):
        try:
            result = compact_day(config.archive_dir, day)
            logger.info(
                "compacted %s: %d source line(s) -> %d Parquet row(s)",
                day,
                result.source_lines,
                result.parquet_rows,
            )
        except Exception:
            # the day stays eligible so the next pass retries it
            logger.exception("compaction failed for %s", day)
            failures += 1

    # Verify-then-delete raw files for every day that has a Parquet output.
    for day in _compacted_days(config.archive_dir):
        try:
            deleted = delete_raw_day(
                config.archive_dir,
                day,
                keep_raw_days=config.compact_keep_raw_days,
                now=now,
            )
            if deleted:
                logger.info("deleted %d raw file(s) for %s", len(deleted), day)
        except VerificationError as e:
            logger.error("%s", e)
            failures += 1
        except Exception:
            logger.exception("verify-then-delete failed for %s", day)
            failures += 1

    return failures


def _seconds_until_next_run(now: datetime) -> float:
    """Seconds from ``now`` until the next 03:00 UTC boundary (could be today)."""
    next_run = now.replace(hour=RUN_HOUR_UTC, minute=0, second=0, microsecond=0)
    if next_run <= now:
        next_run += timedelta(days=1)
    return (next_run - now).total_seconds()


def _loop(config: AppConfig) -> None:
    """Run a pass, then sleep until the next 03:00 UTC, forever.

    No try/except around ``time.sleep`` here: the SIGTERM/SIGINT handler raises
    KeyboardInterrupt, which unwinds the sleep and propagates up to main()'s
    clean-shutdown handler.
    """
    while True:
        now = _now()
        try:
            failures = run_once(config, now)
        except Exception:
            logger.exception("unexpected error during compaction pass")
        else:
            if failures:
                logger.warning("pass complete with %d failing day(s)", failures)
            else:
                logger.info("pass complete")

        delay = _seconds_until_next_run(_now())
        logger.info(
            "sleeping %.1f hour(s) until next run (~%02d:00 UTC)",
            delay / 3600,
            RUN_HOUR_UTC,
        )
        time.sleep(delay)


def _handle_sigterm(signum, frame) -> None:
    logger.info("received SIGTERM, shutting down cleanly")
    raise KeyboardInterrupt()


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="archive-compactor",
        description="Fold closed NDJSON.gz days into zstd Parquet and delete raw files after verification.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="run a single pass and exit (exit status 0 on success, 1 if any day failed)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    signal.signal(signal.SIGTERM, _handle_sigterm)

    args = _parse_args(argv if argv is not None else sys.argv[1:])
    config = AppConfig.from_env()

    if args.once:
        failures = run_once(config, _now())
        sys.exit(1 if failures else 0)

    logger.info(
        "starting daily loop (immediate pass, then daily at ~%02d:00 UTC)",
        RUN_HOUR_UTC,
    )
    try:
        _loop(config)
    except KeyboardInterrupt:
        logger.info("shutdown complete")


if __name__ == "__main__":
    main()
