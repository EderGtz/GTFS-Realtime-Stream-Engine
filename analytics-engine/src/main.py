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

Graceful shutdown: AnalyticsConsumer.run()'s own loop only catches
KeyboardInterrupt (SIGINT, e.g. Ctrl+C), but container orchestrators (Docker in this case), 
send SIGTERM on shutdown, not SIGINT. Left unhandled, a SIGTERM would
kill the process immediately, bypassing Python's exception handling entirely and
skipping every finally block (including MetricsWriter.close() and the Kafka
consumer's own cleanup). SIGTERM is translated into a KeyboardInterrupt here so it
flows through the exact same, already-tested shutdown path, deliberately minimal
rather than adding a stop-flag to AnalyticsConsumer's loop itself.
"""

import signal
import sys

from config import AppConfig
from consumer import AnalyticsConsumer, WindowResult
from db.writer import MetricsWriter, PersistWindowResult
from utils.logger import get_logger

logger = get_logger("analytics-engine.main")

def _handle_sigterm(signum, frame) -> None:
    logger.info("Received SIGTERM, shutting down gracefully...")
    raise KeyboardInterrupt()


def main() -> None:
    signal.signal(signal.SIGTERM, _handle_sigterm)

    try: 
        config = AppConfig.from_env()
    except RuntimeError as e:
        logger.critical(e)
        sys.exit()

    writer = MetricsWriter(mongo_uri=config.mongo_uri)

    def on_window_result(result: WindowResult) -> PersistWindowResult:
        persist_window_result = writer.persist_window(result)
        logger.info(
            "Window persisted: %d bunching action(s), %d deviation result(s).",
            persist_window_result["bunching_written"],
            persist_window_result["deviations_written"]
        )
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
    )

    try:
        consumer.run()
    except KeyboardInterrupt:
        logger.info("Received exit signal. Shutting down...")
    except Exception:
        logger.exception("Fatal error during execution. Exiting.")
        sys.exit(1)
    finally:
        writer.close()
        logger.info("Shutdown complete. Analytics Engine stopped")


if __name__ == "__main__":
    main()