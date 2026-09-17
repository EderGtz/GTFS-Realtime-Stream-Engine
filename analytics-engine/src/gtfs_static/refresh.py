"""
GTFS static data refresh.

Downloads the latest GTFS-static ZIP from MBTA when the remote bundle has
changed (ETag-based conditional fetch), extracts it to the local data
directory, and lets GtfsStaticData.reload_if_changed() pick up the new files.
"""

import zipfile
from pathlib import Path

import requests

from utils.logger import get_logger

logger = get_logger("analytics-engine.gtfs_refresh")

MBTA_GTFS_URL = "https://cdn.mbta.com/MBTA_GTFS.zip"

# Same directory the loader reads from — keep them in sync.
_DEFAULT_GTFS_DIR = Path(__file__).resolve().parents[2] / "data" / "MBTA_GTFS"


def download_and_extract_gtfs(
    target_dir: Path | str = _DEFAULT_GTFS_DIR,
) -> bool:
    """
    Downloads the GTFS static ZIP from MBTA if it has been updated,
    and extracts it to the target directory.

    Returns:
        True if a new version was downloaded and extracted, False otherwise
        (ETag match, network error, or bad ZIP).
    """
    target_path = Path(target_dir)
    target_path.mkdir(parents=True, exist_ok=True)

    etag_file = target_path / ".etag"
    local_etag = ""
    if etag_file.exists():
        local_etag = etag_file.read_text().strip()

    try:
        head_resp = requests.head(MBTA_GTFS_URL, timeout=10)
        head_resp.raise_for_status()

        remote_etag = head_resp.headers.get("etag", "").strip('"')

        if local_etag and remote_etag and local_etag == remote_etag:
            logger.info("GTFS static data is up to date (ETag match).")
            return False

        logger.info("New GTFS static data available (ETag: %s). Downloading...", remote_etag)

        zip_path = target_path / "MBTA_GTFS.zip"
        with requests.get(MBTA_GTFS_URL, stream=True, timeout=60) as r:
            r.raise_for_status()
            with open(zip_path, "wb") as f:
                f.writelines(r.iter_content(chunk_size=8192))

        logger.info("Download complete. Extracting...")
        with zipfile.ZipFile(zip_path, "r") as zip_ref:
            zip_ref.extractall(target_path)

        zip_path.unlink()
        if remote_etag:
            etag_file.write_text(remote_etag)

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
