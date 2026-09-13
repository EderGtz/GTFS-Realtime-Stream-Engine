"""
main.py

Entry point for the analytics engine: wires together GTFS-static data, the
raw.vehicle-positions Kafka consumer, both metrics modules, and MongoDB
persistence into one running process.

Configuration is read directly from environment variables here rather than a
separate config.py, mirroring the fail-loud-on-missing-value discipline
ingestion-service's config.ts already established on the TypeScript side
(envOrThrow).

In this file there were two relevant design decitions:

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

2. enable.auto.commit = True, with a known limitation: auto-commit
   happens on its own timer, independent of whether a buffered message's window
   has actually been flushed and processed yet. If the process crashes between a
   message being added to PingWindowBuffer and its window being flushed, the
   message's Kafka offset may already have been auto-committed, meaning that
   ping is silently lost on restart, never having contributed to a computed
   metric. Correctly fixing this means committing offsets only after a window's
   processing genuinely completes (tying specific offsets to specific windows),
   which is real added complexity not taken on here. Documented rather than
   silently ignored or over-engineered for an MVP, consistent with how this
   project has handled every other known limitation (bunching.py's bucket-jitter
   note, schedule_deviation.py's unvalidated departure-detection note, etc.).

Graceful shutdown: AnalyticsConsumer.run()'s own loop only catches
KeyboardInterrupt (SIGINT, e.g. Ctrl+C), but container orchestrators (Docker in this case), 
send SIGTERM on shutdown, not SIGINT. Left unhandled, a SIGTERM would
kill the process immediately, bypassing Python's exception handling entirely and
skipping every finally block (including MetricsWriter.close() and the Kafka
consumer's own cleanup). SIGTERM is translated into a KeyboardInterrupt here so it
flows through the exact same, already-tested shutdown path, deliberately minimal
rather than adding a stop-flag to AnalyticsConsumer's loop itself.
"""

import os
import signal
import sys

from db.writer import MetricsWriter
from utils.logger import get_logger

from .consumer import AnalyticsConsumer, WindowResult

logger = get_logger("analytics-engine.main")

def _env_or_throw(key: str) -> str:
    """Fail at startup on missing mandatory values"""
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"Could not find mandatory environment variable: {key}")
    return value


def _load_config() -> dict:
    return {
        "kafka_brokers": _env_or_throw("KAFKA_BROKER"),
        "kafka_topic": os.environ.get("KAFKA_TOPIC", "raw.vehicle-positions"),
        "kafka_group_id": os.environ.get("KAFKA_GROUP_ID", "analytics-engine"),
        "mongo_uri": _env_or_throw("MONGO_URI"),
        "gtfs_dir": os.environ.get("GTFS_STATIC_DIR"),  # None -> GtfsStaticData's own default path
    }


def _handle_sigterm(signum, frame) -> None:
    logger.info("Received SIGTERM, shutting down gracefully...")
    raise KeyboardInterrupt()


def main() -> None:
    signal.signal(signal.SIGTERM, _handle_sigterm)

    config = _load_config()

    writer = MetricsWriter(mongo_uri=config["mongo_uri"])

    def on_window_result(result: WindowResult) -> None:
        bunching_written = writer.write_bunching_actions(result.bunching_actions)
        deviations_written = writer.write_deviation_results(result.new_deviations)
        logger.info(
            "Window persisted: %d bunching action(s), %d deviation result(s).",
            bunching_written, deviations_written,
        )

    kafka_config = {
        "bootstrap.servers": config["kafka_brokers"],
        "group.id": config["kafka_group_id"],
        "auto.offset.reset": "latest",  # see module docstring, point 1
        "enable.auto.commit": True,     # see module docstring, point 2
    }

    consumer = AnalyticsConsumer(
        kafka_config=kafka_config,
        topic=config["kafka_topic"],
        gtfs_dir=config["gtfs_dir"],
        on_window_result=on_window_result,
    )

    try:
        consumer.run()
    finally:
        # AnalyticsConsumer.run() already closes its own Kafka consumer in its own
        # finally block. This one closes what main.py itself owns (the writer's
        # Mongo connection), regardless of whether run() exited via a
        # SIGTERM-turned-KeyboardInterrupt, a real Ctrl+C, or an unexpected
        # exception propagating out of the loop.
        writer.close()
        logger.info("Shutdown complete.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logger.exception("Fatal error during startup or execution. Exiting.")
        sys.exit(1)