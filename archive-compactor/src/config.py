"""
One immutable snapshot of the process environment, read once at startup.
Unlike other modules of the repo,  there are no mandatory, secret-bearing
variables in this one: this compactor only touches local files, so every
knob has a sane default and a missing variable is recoverable rather than fatal.
"""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# Defaults mirror the Phase 2 design table in the roadmap plan:
#   48h is the minimum age before a day is eligible to compact (eligibility.py),
#   7d  is the grace period before verified raw files are deleted (Task 11).
DEFAULT_COMPACT_MIN_AGE_HOURS = 48
DEFAULT_COMPACT_KEEP_RAW_DAYS = 7


@dataclass(frozen=True)
class AppConfig:
    """
    Compactor runtime configuration.
    """

    # Root of the raw NDJSON.gz archive tree (the Go consumer's ARCHIVE_DIR):
    #   <archive_dir>/YYYY-MM-DD/HH.ndjson.gz            (raw tier)
    #   <archive_dir>/parquet/date=YYYY-MM-DD/...        (compacted tier)
    # Defaults to "../data/archive" so a run executed from archive-compactor/
    # resolves the repo-root data/archive — the same directory archive-consumer
    # points one level up for host runs (Docker Compose overrides this to
    # /data/archive inside the container).
    archive_dir: Path

    # Minimum hours a day dir must be older than (measured from its 00:00 UTC)
    # before it is eligible to compact. main.py will pass this config value
    # in once it wires config -> eligibility.
    compact_min_age_hours: int

    # Grace period, in whole days, before *verified* raw files are deleted.
    # 0 = delete immediately after verification.
    compact_keep_raw_days: int

    @classmethod
    def from_env(cls) -> "AppConfig":
        """
        Build config from the environment, falling back to documented defaults.
        """
        return cls(
            archive_dir=Path(os.getenv("ARCHIVE_DIR", "../data/archive")),
            compact_min_age_hours=int(
                os.getenv("COMPACT_MIN_AGE_HOURS", str(DEFAULT_COMPACT_MIN_AGE_HOURS))
            ),
            compact_keep_raw_days=int(
                os.getenv("COMPACT_KEEP_RAW_DAYS", str(DEFAULT_COMPACT_KEEP_RAW_DAYS))
            ),
        )
