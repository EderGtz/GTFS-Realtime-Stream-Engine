"""
main.py

Entry point for the analytics engine: wires together GTFS-static data, the
raw.vehicle-positions Kafka consumer, both metrics modules, and MongoDB
persistence into one running process.

Configuration is read directly from environment variables here rather than a
separate config.py, mirroring the fail-loud-on-missing-value discipline
ingestion-service's config.ts already established on the TypeScript side
(envOrThrow).

In this file there were two relevant design decisions:

1. auto.offset.reset = "latest", not "earliest". The notebooks always used
   "earliest", which was correct for one-off exploration/backfill, but it is wrong for a
   continuously-running production consumer for the following reasons:
   With "earliest", every restart would replay the full retained backlog
   (up to 72h per docker-compose.yml's KAFKA_LOG_RETENTION_HOURS) as if it were new,
   which would cause a large processing lag spike and potentially, re-emitting "new"
   bunching events for long-past history, before even catching up to real time.
   "latest" means a restart picks up from the current tail, but some messages published
   during the restart window are missed, which is being accepted as a documented gap for
   this MVP rather than something solved.

Graceful shutdown: AnalyticsConsumer.run()'s own loop only catches
KeyboardInterrupt (SIGINT, e.g. Ctrl+C), but container orchestrators (Docker in this case),
send SIGTERM on shutdown, not SIGINT. Left unhandled, a SIGTERM would
kill the process immediately, bypassing Python's exception handling entirely and
skipping every finally block (including MetricsWriter.close() and the Kafka
consumer's own cleanup). SIGTERM is translated into a KeyboardInterrupt here so it
flows through the exact same, already-tested shutdown path, deliberately minimal
rather than adding a stop-flag to AnalyticsConsumer's loop itself.
"""

import datetime
import signal
import sys
import threading
import time
from pathlib import Path

from config import AppConfig
from consumer import AnalyticsConsumer, WindowResult, download_and_extract_gtfs
from db.pg_schema import HourlyStats
from db.pg_writer import HourlyAccumulator, PgWriter
from db.writer import MetricsWriter, PersistWindowResult
from utils.logger import get_logger

logger = get_logger("analytics-engine.main")


def _handle_sigterm(signum, frame) -> None:
    logger.info("Received SIGTERM, shutting down gracefully...")
    raise KeyboardInterrupt()


def main() -> None:
    signal.signal(signal.SIGTERM, _handle_sigterm)

    # Liveness heartbeat for the compose healthcheck: a daemon thread touches
    # a file every 30s while the process is alive. Deliberately liveness-only —
    # "no data flowing" (quiet feed) must not mark the container unhealthy.
    def _heartbeat() -> None:
        beat = Path("/tmp/analytics-heartbeat")
        while True:
            beat.touch()
            time.sleep(30)

    threading.Thread(target=_heartbeat, daemon=True).start()

    try:
        config = AppConfig.from_env()
    except RuntimeError as e:
        logger.critical(e)
        sys.exit(1)

    logger.info("Checking for GTFS-static updates on startup...")
    download_and_extract_gtfs()

    writer = MetricsWriter(mongo_uri=config.mongo_uri)
    pg_writer = PgWriter(dsn=config.pg_dsn)
    accumulator = HourlyAccumulator()

    # Postgres is the historical-stats side store: a failure there must not
    # kill the consumer or block offset commits (Mongo is the live-state store).
    # Flushed hours are buffered here and retried on later windows instead.
    # The buffer is one row per route per hour, so unbounded growth is not a
    # practical concern.
    PG_RETRY_INTERVAL_SECONDS = 60
    pending_pg_rows: list[HourlyStats] = []
    next_pg_retry_at = 0.0

    def flush_pending_pg_rows(force: bool = False) -> bool:
        """Try to persist buffered rows. Returns True when nothing is pending.

        PgWriter.upsert_hourly_stats() logs and returns 0 on a database error
        rather than raising, so success is detected from the return value.
        After a failure the connection may be dead (Postgres restarted), so
        reconnect before the next attempt.
        """
        nonlocal next_pg_retry_at, pg_writer
        if not pending_pg_rows:
            return True

        now = time.monotonic()
        if not force and now < next_pg_retry_at:
            return False

        try:
            written = pg_writer.upsert_hourly_stats(pending_pg_rows)
        except Exception:
            logger.exception(
                "PostgreSQL upsert raised; %d row(s) buffered for retry.",
                len(pending_pg_rows),
            )
            written = 0

        if written == len(pending_pg_rows):
            pending_pg_rows.clear()
            next_pg_retry_at = 0.0
            return True

        next_pg_retry_at = now + PG_RETRY_INTERVAL_SECONDS
        logger.warning(
            "PostgreSQL upsert failed; %d row(s) buffered, retrying in %ds.",
            len(pending_pg_rows),
            PG_RETRY_INTERVAL_SECONDS,
        )
        try:
            pg_writer.reconnect()
        except Exception:
            logger.exception("PostgreSQL reconnect failed; will retry later.")
        return False

    def pg_upsert(rows: list[HourlyStats]) -> None:
        pending_pg_rows.extend(rows)
        flush_pending_pg_rows(force=True)

    def on_window_result(result: WindowResult) -> PersistWindowResult:
        persist_window_result = writer.persist_window(result)
        logger.info(
            "Window persisted: %d record(s) examined, %d bunching action(s), %d deviation result(s).",
            result.total_records,
            persist_window_result["bunching_written"],
            persist_window_result["deviations_written"],
        )

        # Feed into the hourly accumulator for PostgreSQL.
        # On hour boundary, flush aggregated stats to Postgres.
        accumulator.accumulate(result)
        flushed = accumulator.maybe_flush(datetime.datetime.now(datetime.UTC))
        if flushed:
            pg_upsert(flushed)
        else:
            # Retry buffered rows between hour boundaries (no-op when empty).
            flush_pending_pg_rows()

        return persist_window_result

    kafka_config = {
        "bootstrap.servers": config.kafka_brokers,
        "group.id": config.kafka_group_id,
        "auto.offset.reset": "latest",
        "enable.auto.commit": False,
    }

    consumer = AnalyticsConsumer(
        kafka_config=kafka_config,
        topic=config.kafka_topic,
        on_window_result=on_window_result,
        retry_base_seconds=config.mongo_retry_base_seconds,
        retry_max_seconds=config.mongo_retry_max_seconds,
        retry_jitter_seconds=config.mongo_retry_jitter_seconds,
    )

    try:
        consumer.run()
    except KeyboardInterrupt:
        logger.info("Received exit signal. Shutting down...")
    except Exception:
        logger.exception("Fatal error during execution. Exiting.")
        sys.exit(1)
    finally:
        # Flush any partial hour's data before closing.
        flushed = accumulator.flush_remaining()
        if flushed:
            pg_upsert(flushed)
        elif pending_pg_rows:
            flush_pending_pg_rows(force=True)
        # The attempt above may have triggered a reconnect; try once more on
        # the fresh connection before giving up.
        if pending_pg_rows:
            flush_pending_pg_rows(force=True)
        if pending_pg_rows:
            logger.error(
                "Dropping %d PostgreSQL row(s) at shutdown: database still unavailable.",
                len(pending_pg_rows),
            )
        pg_writer.close()
        writer.close()
        logger.info("Shutdown complete. Analytics Engine stopped")


if __name__ == "__main__":
    main()
