"""
GTFS static data refresh.

Downloads the latest GTFS-static ZIP from MBTA when the remote bundle has
changed (ETag-based conditional fetch, falling back to Last-Modified), extracts
it into a staging directory, validates it, and swaps it into place. The loader's
reload_if_changed() then picks up the new files.

The staging-then-swap flow is deliberate. The previous implementation extracted
over the live directory with extractall, which had two failure modes (M4 in the
hardening review): a file dropped from a new bundle version survived from the
old one and silently changed which services were considered active, and any
download/extract failure could leave a half-written bundle on disk. A new
bundle is now only swapped in once it is fully extracted and contains every
file the loader requires; anything less keeps the current bundle untouched.
"""

import shutil
import tempfile
import zipfile
from pathlib import Path

import requests

from utils.logger import get_logger

logger = get_logger("analytics-engine.gtfs_refresh")

MBTA_GTFS_URL = "https://cdn.mbta.com/MBTA_GTFS.zip"

# Same directory the loader reads from — keep them in sync.
_DEFAULT_GTFS_DIR = Path(__file__).resolve().parents[2] / "data" / "MBTA_GTFS"

# A bundle is only swapped in if it contains at least the files the loader
# requires — an incomplete extraction must never replace a working bundle.
_REQUIRED_FILES = ("stops.txt", "trips.txt", "stop_times.txt", "routes.txt")


def download_and_extract_gtfs(
    target_dir: Path | str = _DEFAULT_GTFS_DIR,
) -> bool:
    """
    Downloads the GTFS static ZIP from MBTA if it has been updated,
    and swaps it into the target directory.

    Returns:
        True if a new version was downloaded, extracted, and swapped in,
        False otherwise (validator match, network error, bad ZIP, or an
        incomplete bundle — in every failure case the current on-disk
        bundle is left untouched).
    """
    target_path = Path(target_dir)
    target_path.mkdir(parents=True, exist_ok=True)

    # Recover from a crash between the two renames of the swap below: the
    # previous bundle is parked at *.old and must never be lost to a stray
    # restart mid-swap.
    old_path = target_path.parent / f"{target_path.name}.old"
    if not target_path.exists() and old_path.exists():
        old_path.rename(target_path)

    try:
        remote_etag, remote_last_modified = _fetch_validators()
        if _bundle_is_current(target_path, remote_etag, remote_last_modified):
            logger.info("GTFS static data is up to date (validator match).")
            return False

        logger.info("New GTFS static data available. Downloading...")

        with tempfile.TemporaryDirectory(
            dir=target_path.parent, prefix=".gtfs-staging-"
        ) as staging_name:
            staging = Path(staging_name)
            contents = staging / "contents"
            contents.mkdir()
            zip_path = staging / "MBTA_GTFS.zip"

            with requests.get(MBTA_GTFS_URL, stream=True, timeout=60) as r:
                r.raise_for_status()
                with open(zip_path, "wb") as f:
                    f.writelines(r.iter_content(chunk_size=8192))

            logger.info("Download complete. Extracting...")
            with zipfile.ZipFile(zip_path, "r") as zip_ref:
                zip_ref.extractall(contents)

            missing = [fn for fn in _REQUIRED_FILES if not (contents / fn).exists()]
            if missing:
                logger.error(
                    "Downloaded GTFS bundle is missing %s; keeping current bundle.",
                    missing,
                )
                return False

            if remote_etag:
                (contents / ".etag").write_text(remote_etag)
            if remote_last_modified:
                (contents / ".last_modified").write_text(remote_last_modified)

            _swap_into_place(contents, target_path, old_path)

        logger.info("GTFS static data updated successfully.")
        return True

    except requests.RequestException as e:
        logger.error("Network error fetching GTFS static data: %s", e)
        return False
    except zipfile.BadZipFile as e:
        logger.error("Downloaded file is not a valid ZIP: %s", e)
        return False
    except Exception:
        logger.exception("Unexpected error during GTFS refresh")
        return False


def _fetch_validators() -> tuple[str | None, str | None]:
    """Return the remote change validators: (ETag, Last-Modified), either may
    be None when the server doesn't send the header."""
    head_resp = requests.head(MBTA_GTFS_URL, timeout=10)
    head_resp.raise_for_status()
    etag = head_resp.headers.get("etag", "").strip('"') or None
    last_modified = head_resp.headers.get("last-modified", "").strip() or None
    return etag, last_modified


def _bundle_is_current(
    target_path: Path,
    remote_etag: str | None,
    remote_last_modified: str | None,
) -> bool:
    """Compare the remote validators against what's on disk.

    ETag is the primary signal (MBTA's CDN serves one); Last-Modified is the
    fallback for servers without ETags. With neither, every call re-downloads.
    """
    if remote_etag:
        local = _read_validator(target_path, ".etag")
        return local is not None and local == remote_etag
    if remote_last_modified:
        local = _read_validator(target_path, ".last_modified")
        return local is not None and local == remote_last_modified
    return False


def _read_validator(target_path: Path, name: str) -> str | None:
    path = target_path / name
    if path.exists():
        return path.read_text().strip()
    return None


def _swap_into_place(contents: Path, target_path: Path, old_path: Path) -> None:
    """Move a fully-extracted bundle into place, keeping the previous one
    recoverable until the swap has completed."""
    if old_path.exists():
        shutil.rmtree(old_path)
    if target_path.exists():
        target_path.rename(old_path)
    contents.rename(target_path)
    if old_path.exists():
        shutil.rmtree(old_path)
