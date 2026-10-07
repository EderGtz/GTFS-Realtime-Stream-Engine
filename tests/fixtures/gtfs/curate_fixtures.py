#!/usr/bin/env python3
"""
Rebuild the curated GTFS fixture feeds in this directory.

The integration test suites used to run only on tiny hand-written DataFrames,
which never exercised real-world GTFS quirks. These fixtures give them real
feed data to work with, curated from the two sample-dataset sources listed in
awesome-transit's "Sample GTFS and GTFS Realtime datasets used for software
testing" section:

  - transitland-lib testdata (real agency feed snapshots + validator error
    layers): https://github.com/interline-io/transitland-lib
    (listed as "Transitland GTFS and GTFS Realtime unit tests")

Usage:
    git clone --depth 1 https://github.com/interline-io/transitland-lib.git
    python3 curate_fixtures.py --source /path/to/transitland-lib/testdata

The script is stdlib-only and deterministic: same source checkout in, byte-same
fixtures out (zip timestamps are normalized). See README.md in this directory
for provenance, licenses, and the quirk each fixture covers.

WHY trim at all: real agency feeds are 5-300 MB uncompressed. The repo fixture
budget is <1 MB compressed per feed, so large feeds are cut down to a few
representative routes. Trimming rules per feed are documented in README.md and
implemented below; every kept row is verbatim from upstream (only rows are
dropped, never edited), except the two validator-layer fixtures which apply
upstream's own error-file overlays on top of upstream's base feed.
"""

from __future__ import annotations

import argparse
import csv
import io
import zipfile
from pathlib import Path

MAX_FIXTURE_BYTES = 1_000_000  # repo budget per fixture: under 1 MB compressed

# Zip entries get a fixed timestamp so rebuilds are byte-deterministic.
FIXED_DATE = (2026, 10, 6, 0, 0, 0)


# CSV/zip helpers

class DirReader:
    """Adapter so read_csv() can read plain files from a directory like a zip."""

    def __init__(self, directory: Path):
        self._dir = directory

    def open(self, name: str) -> io.BufferedReader:
        return (self._dir / name).open("rb")


def read_csv(src: zipfile.ZipFile | DirReader, name: str) -> tuple[list[str], list[dict[str, str]]]:
    """Opens and processes a CSV file from a ZIP archive or directory, enforcing 
    strict column validation and normalizing empty values.

    Args:
        src: The source container, either an opened zipfile.ZipFile object 
            or a DirReader instance.
        name: The name or path of the CSV file to read inside the source.

    Returns:
        A tuple containing two elements: tuple[list[str], list[dict[str, str]]]:
        
            list[str] (fieldnames): 
                A list of strings representing the column headers in the exact order 
                they appear in the file. If the file is empty or lacks headers, 
                returns an empty list.

            list[dict[str, str]] (rows): 
                A list of dictionaries representing each data row. Each dictionary 
                maps a column header (key) to its corresponding cell data (value) 
                as a string. Missing or null values are automatically normalized 
                to empty strings ("").

    Raises:
        ValueError: If any row contains extra unmapped data columns that are 
            not just harmless trailing empty commas (e.g., artifacts from 
            upstream exports or spreadsheet software).
    """
    with src.open(name) as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))
        rows = []
        for row in reader:
            # Upstream feeds have rows with trailing commas (one empty extra
            # column). Harmless; anything else extra is real data and must not
            # be silently dropped.
            extras = row.pop(None, None)
            if extras and any(e.strip() for e in extras):
                raise ValueError(f"{name}: row has unexpected extra columns: {extras}")
            rows.append({k: (v or "") for k, v in row.items()})
        return list(reader.fieldnames or []), rows


def write_feed(dest: Path, files: dict[str, tuple[list[str], list[dict[str, str]]]]) -> int:
    """Compiles and compresses multiple CSV datasets into a single reproducible ZIP archive.

    This function formats in-memory rows into standard CSV text buffers and packages 
    them deterministically. It enforces a consistent file ordering, uses standard 
    Unix line endings (LF), and overwrites zip metadata timestamps with a fixed date 
    to ensure byte-for-byte reproducibility across runs. It also verifies that the 
    final bundle size does not exceed the allowed fixture byte budget.

    Args:
        dest: The file system path where the resulting ZIP archive will be written.
        files: A dictionary mapping target filenames (e.g., 'stops.txt') to their 
            corresponding contents payload structured as a tuple of:
            - list[str]: The column headers (fieldnames).
            - list[dict[str, str]]: The rows mapping column headers to cell text values.

    Returns:
        int: The exact size of the newly generated ZIP archive in bytes.

    Raises:
        SystemExit: If the final compressed ZIP file size meets or exceeds the 
            predefined `MAX_FIXTURE_BYTES` performance budget limit.
    """
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, (fieldnames, rows) in sorted(files.items()):
            buf = io.StringIO(newline="")
            writer = csv.DictWriter(buf, fieldnames=fieldnames, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, buf.getvalue())
    size = dest.stat().st_size
    if size >= MAX_FIXTURE_BYTES:
        raise SystemExit(f"{dest.name} is {size} bytes (budget {MAX_FIXTURE_BYTES})")
    return size


def trim(
    source: Path,
    *,
    route_ids: set[str],
    stops_rule: str,
    keep_files: list[str],
    drop_calendar: bool = False,
) -> dict[str, tuple[list[str], list[dict[str, str]]]]:
    """Cut a real feed down to the trips of `route_ids`.

    - trips.txt: only trips of the kept routes.
    - stop_times.txt: only rows of kept trips.
    - stops.txt: `stops_rule` == "referenced" keeps stops used by kept
      stop_times; == "referenced+blank-coords" additionally keeps every stop
      with a missing/blank latitude (preserves the broken-coordinate quirk
      density of the full feed).
    - Every file in `keep_files` is copied verbatim.
    - drop_calendar=True omits calendar.txt even if upstream has one.
    """
    with zipfile.ZipFile(source) as zf:
        out: dict[str, tuple[list[str], list[dict[str, str]]]] = {}
        for name in keep_files:
            out[name] = read_csv(zf, name)

        _, trips = read_csv(zf, "trips.txt")
        kept_trips = [t for t in trips if t["route_id"] in route_ids]
        kept_trip_ids = {t["trip_id"] for t in kept_trips}

        _, stop_times = read_csv(zf, "stop_times.txt")
        kept_stop_times = [s for s in stop_times if s["trip_id"] in kept_trip_ids]

        stops_fields, stops = read_csv(zf, "stops.txt")
        referenced = {s["stop_id"] for s in kept_stop_times}
        kept_stops = [
            s
            for s in stops
            if s["stop_id"] in referenced
            or (stops_rule == "referenced+blank-coords" and not s.get("stop_lat", "").strip())
        ]

        out["trips.txt"] = (list(kept_trips[0].keys()), kept_trips)
        out["stop_times.txt"] = (list(kept_stop_times[0].keys()), kept_stop_times)
        out["stops.txt"] = (stops_fields, kept_stops)

        if drop_calendar:
            out.pop("calendar.txt", None)
        return out


def build_validator_layer(testdata: Path, layer: str) -> dict[str, tuple[list[str], list[dict[str, str]]]]:
    """Upstream's gtfs-validator-layers feed = base/ + one error-file overlay.

    The overlay directories contain only the file that carries the defect; the
    rest of the feed comes from base/. This mirrors exactly how transitland-lib's
    own validator tests compose these fixtures.
    """
    base = DirReader(testdata / "gtfs-validator-layers" / "base")
    overlay = DirReader(testdata / "gtfs-validator-layers" / "errors" / layer)
    out: dict[str, tuple[list[str], list[dict[str, str]]]] = {}
    for path in sorted((testdata / "gtfs-validator-layers" / "base").glob("*.txt")):
        out[path.name] = read_csv(base, path.name)
    for path in sorted((testdata / "gtfs-validator-layers" / "errors" / layer).glob("*.txt")):
        out[path.name] = read_csv(overlay, path.name)
    return out


# ---------------------------------------------------------------------------
# fixture definitions
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        help="path to a checkout of interline-io/transitland-lib's testdata/ directory",
    )
    args = parser.parse_args()
    testdata: Path = args.source
    out_dir = Path(__file__).resolve().parent

    for required in ("gtfs-external/mbta.zip", "server/gtfs/wmata.zip", "gtfs-validator-layers/base"):
        if not (testdata / required).exists():
            raise SystemExit(f"source testdata is missing {required!r} -- wrong path?")

    # 1. Real MBTA snapshot (2019-07-25), trimmed to bus 1, bus 28, and the Red
    #    Line. Quirks kept: 1147 stops with blank coordinates (MBTA generic
    #    "node-*-platform" entries), non-numeric trip_ids (incl. colons).
    mbta = trim(
        testdata / "gtfs-external" / "mbta.zip",
        route_ids={"1", "28", "Red"},
        stops_rule="referenced+blank-coords",
        keep_files=["agency.txt", "calendar.txt", "calendar_dates.txt", "feed_info.txt", "routes.txt"],
    )
    size = write_feed(out_dir / "mbta-2019-07-25.zip", mbta)
    print(f"mbta-2019-07-25.zip: {size} bytes")

    # 2. Real WMATA snapshot (2026-04-29), trimmed to Metrorail Red plus
    #    the SHUTTLE route. Quirks kept: NO calendar.txt (calendar_dates-only
    #    service periods), empty route_long_name on SHUTTLE.
    wmata = trim(
        testdata / "server" / "gtfs" / "wmata.zip",
        route_ids={"RED", "SHUTTLE"},
        stops_rule="referenced",
        keep_files=["agency.txt", "calendar_dates.txt", "feed_info.txt", "routes.txt"],
        drop_calendar=True,
    )
    size = write_feed(out_dir / "wmata-2026-04-29.zip", wmata)
    print(f"wmata-2026-04-29.zip: {size} bytes")

    # 3. Real BART snapshot (2010-era), kept verbatim -- small enough already.
    #    Quirks kept: 870 stop_times rows with times >= 24:00:00 (past-midnight),
    #    alphanumeric trip_ids.
    bart_fields = {}
    with zipfile.ZipFile(testdata / "server" / "gtfs" / "bart-errors.zip") as zf:
        for name in zf.namelist():
            bart_fields[name] = read_csv(zf, name)
    size = write_feed(out_dir / "bart-2010.zip", bart_fields)
    print(f"bart-2010.zip: {size} bytes")

    # 4+5. transitland-lib validator-layer defects, applied over the same base
    #    feed upstream uses. Quirks: duplicate trip_ids in trips.txt, and
    #    stop_times.txt rows referencing a trip_id absent from trips.txt.
    for layer, out_name in (
        ("trips-duplicate", "duplicate-trip-ids.zip"),
        ("stop_times-unknown-trip_id", "orphan-stop-times.zip"),
    ):
        feed = build_validator_layer(testdata, layer)
        size = write_feed(out_dir / out_name, feed)
        print(f"{out_name}: {size} bytes")

    print("all fixtures within budget:", MAX_FIXTURE_BYTES, "bytes each")


if __name__ == "__main__":
    main()
