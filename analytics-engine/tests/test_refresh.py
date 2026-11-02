"""
Unit tests for gtfs_static/refresh.py.

Mocks HTTP calls to avoid real network traffic.  Uses tmp_path for the
target directory so tests are fully isolated from the real data/ directory.
"""

import io
import zipfile

import requests
from urllib3.response import HTTPResponse as Urllib3HTTPResponse

from gtfs_static.refresh import download_and_extract_gtfs

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_head_response(etag: str = '"abc123"', status: int = 200):
    """Build a mock requests.Response for the HEAD request."""
    resp = requests.Response()
    resp.status_code = status
    resp.headers["ETag"] = f'"{etag.strip(chr(34))}"'
    resp.url = "https://cdn.mbta.com/MBTA_GTFS.zip"
    return resp


def _make_zip_bytes(
    files: dict[str, str] | None = None, omit: tuple[str, ...] = ()
) -> bytes:
    """Create a minimal valid ZIP containing the given text files.

    Merges in the files the refresh bundle validation requires by default so
    tests exercise the swap path; pass ``omit`` to drop a required file and
    exercise the incomplete-bundle guard.
    """
    all_files = {
        "trips.txt": "trip_id\n",
        "stops.txt": "stop_id\n",
        "stop_times.txt": "trip_id,stop_sequence\n",
        "routes.txt": "route_id\n",
    }
    all_files.update(files or {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in all_files.items():
            if name in omit:
                continue
            zf.writestr(name, content)
    return buf.getvalue()


def _make_get_response(content: bytes, status: int = 200):
    """Build a mock requests.Response that supports streaming.

    refresh.py uses ``requests.get(..., stream=True)`` and then calls
    ``r.iter_content()``, which reads from ``r.raw`` (a urllib3 HTTPResponse).
    We wire up a BytesIO-backed urllib3 response so the streaming loop works.
    """
    resp = requests.Response()
    resp.status_code = status
    resp.url = "https://cdn.mbta.com/MBTA_GTFS.zip"

    # urllib3 HTTPResponse wrapping the zip bytes — this is what iter_content reads
    resp.raw = Urllib3HTTPResponse(
        body=io.BytesIO(content),
        headers={},
        status=status,
        preload_content=False,
    )
    resp.headers["Content-Length"] = str(len(content))
    return resp


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestETagCaching:
    """ETag-based conditional fetch: skip download when remote hasn't changed."""

    def test_returns_false_when_etag_matches(self, tmp_path, monkeypatch):
        """Local .etag matches remote → no download, return False."""
        (tmp_path / ".etag").write_text("abc123")

        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("abc123"),
        )

        result = download_and_extract_gtfs(tmp_path)

        assert result is False
        # ZIP should not have been created
        assert not (tmp_path / "MBTA_GTFS.zip").exists()

    def test_downloads_when_etag_differs(self, tmp_path, monkeypatch):
        """Local .etag differs from remote → download, return True."""
        (tmp_path / ".etag").write_text("old_etag")

        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("new_etag"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(_make_zip_bytes()),
        )

        result = download_and_extract_gtfs(tmp_path)

        assert result is True
        assert (tmp_path / ".etag").read_text() == "new_etag"

    def test_downloads_when_no_local_etag(self, tmp_path, monkeypatch):
        """No .etag file on disk → always downloads."""
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("first_etag"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(_make_zip_bytes()),
        )

        result = download_and_extract_gtfs(tmp_path)

        assert result is True
        assert (tmp_path / ".etag").read_text() == "first_etag"

    def test_downloads_when_remote_has_no_etag_header(self, tmp_path, monkeypatch):
        """Remote doesn't send ETag → download proceeds (can't compare)."""
        head_resp = requests.Response()
        head_resp.status_code = 200
        # No ETag header
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: head_resp,
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(_make_zip_bytes()),
        )

        result = download_and_extract_gtfs(tmp_path)

        assert result is True


class TestDownloadAndExtract:
    """ZIP download, extraction, and cleanup."""

    def test_extracts_files_to_target_directory(self, tmp_path, monkeypatch):
        """Downloaded ZIP contents should appear in target_dir."""
        zip_content = _make_zip_bytes(
            {
                "trips.txt": "trip_id,route_id\n1,Red\n",
                "stops.txt": "stop_id,stop_name\n70001,Alewife\n",
            }
        )

        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v1"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(zip_content),
        )

        download_and_extract_gtfs(tmp_path)

        assert (tmp_path / "trips.txt").exists()
        assert (tmp_path / "stops.txt").exists()
        assert "Alewife" in (tmp_path / "stops.txt").read_text()

    def test_removes_zip_after_extraction(self, tmp_path, monkeypatch):
        """The temporary ZIP file should be deleted after extraction."""
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v1"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(_make_zip_bytes()),
        )

        download_and_extract_gtfs(tmp_path)

        assert not (tmp_path / "MBTA_GTFS.zip").exists()

    def test_creates_target_directory_if_missing(self, tmp_path, monkeypatch):
        """Target directory should be created if it doesn't exist."""
        target = tmp_path / "subdir" / "gtfs"

        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v1"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(_make_zip_bytes()),
        )

        result = download_and_extract_gtfs(target)

        assert result is True
        assert target.exists()

    def test_saves_etag_only_after_successful_download(self, tmp_path, monkeypatch):
        """.etag file should be written with the remote ETag after extraction."""
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("saved_etag"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(_make_zip_bytes()),
        )

        download_and_extract_gtfs(tmp_path)

        assert (tmp_path / ".etag").read_text() == "saved_etag"

    def test_no_etag_saved_when_remote_etag_is_empty(self, tmp_path, monkeypatch):
        """If the remote sends no ETag, don't write a .etag file."""
        head_resp = requests.Response()
        head_resp.status_code = 200
        # No ETag header
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: head_resp,
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(_make_zip_bytes()),
        )

        download_and_extract_gtfs(tmp_path)

        assert not (tmp_path / ".etag").exists()


class TestErrorHandling:
    """Graceful degradation: log and return False on any failure."""

    def test_returns_false_on_head_request_failure(self, tmp_path, monkeypatch):
        """HEAD request raises → return False, no crash."""
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: (_ for _ in ()).throw(requests.ConnectionError("DNS")),
        )

        result = download_and_extract_gtfs(tmp_path)
        assert result is False

    def test_returns_false_on_download_failure(self, tmp_path, monkeypatch):
        """GET request raises → return False, no crash."""
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v1"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: (_ for _ in ()).throw(requests.ConnectionError("timeout")),
        )

        result = download_and_extract_gtfs(tmp_path)
        assert result is False

    def test_returns_false_on_404_head_response(self, tmp_path, monkeypatch):
        """HEAD returns 404 → raise_for_status() → return False."""
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v1", status=404),
        )

        result = download_and_extract_gtfs(tmp_path)
        assert result is False

    def test_returns_false_on_bad_zip(self, tmp_path, monkeypatch):
        """Downloaded file is not a valid ZIP → return False."""
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v1"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(b"not a zip file"),
        )

        result = download_and_extract_gtfs(tmp_path)
        assert result is False

    def test_returns_false_on_empty_zip(self, tmp_path, monkeypatch):
        """Empty ZIP → BadZipFile → return False."""
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v1"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(b""),
        )

        result = download_and_extract_gtfs(tmp_path)
        assert result is False


class TestAtomicSwap:
    """Staging-then-swap semantics (M4 in the hardening review): a file
    dropped from a new bundle version must not survive from the old one, and
    no failure may damage the bundle currently in use."""

    def _seed_old_bundle(self, tmp_path):
        (tmp_path / ".etag").write_text("v1")
        (tmp_path / "trips.txt").write_text("trip_id\nold\n")
        (tmp_path / "stops.txt").write_text("stop_id\n")
        (tmp_path / "stop_times.txt").write_text("trip_id,stop_sequence\n")
        (tmp_path / "routes.txt").write_text("route_id\n")

    def test_stale_file_removed_when_absent_from_new_bundle(
        self, tmp_path, monkeypatch
    ):
        self._seed_old_bundle(tmp_path)
        (tmp_path / "calendar_dates.txt").write_text("service_id,date\n")

        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v2"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(
                _make_zip_bytes({"trips.txt": "trip_id\nnew\n"})
            ),
        )

        result = download_and_extract_gtfs(tmp_path)
        assert result is True
        assert not (tmp_path / "calendar_dates.txt").exists()
        assert "new" in (tmp_path / "trips.txt").read_text()

    def test_incomplete_bundle_is_not_swapped_in(self, tmp_path, monkeypatch):
        self._seed_old_bundle(tmp_path)

        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v2"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: _make_get_response(
                _make_zip_bytes(omit=("stop_times.txt",))
            ),
        )

        result = download_and_extract_gtfs(tmp_path)
        assert result is False
        assert "old" in (tmp_path / "trips.txt").read_text()
        assert (tmp_path / ".etag").read_text() == "v1"

    def test_failed_download_keeps_existing_bundle(self, tmp_path, monkeypatch):
        self._seed_old_bundle(tmp_path)

        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head",
            lambda *a, **kw: _make_head_response("v2"),
        )
        monkeypatch.setattr(
            "gtfs_static.refresh.requests.get",
            lambda *a, **kw: (_ for _ in ()).throw(requests.ConnectionError("x")),
        )

        result = download_and_extract_gtfs(tmp_path)
        assert result is False
        assert "old" in (tmp_path / "trips.txt").read_text()
        assert (tmp_path / ".etag").read_text() == "v1"

    def test_last_modified_fallback_detects_no_change(self, tmp_path, monkeypatch):
        """Without a remote ETag, Last-Modified is the change validator."""
        head_resp = requests.Response()
        head_resp.status_code = 200
        head_resp.headers["Last-Modified"] = "Mon, 02 Nov 2026 10:00:00 GMT"

        calls = {"get": 0}

        def fake_get(*a, **kw):
            calls["get"] += 1
            return _make_get_response(_make_zip_bytes())

        monkeypatch.setattr(
            "gtfs_static.refresh.requests.head", lambda *a, **kw: head_resp
        )
        monkeypatch.setattr("gtfs_static.refresh.requests.get", fake_get)

        assert download_and_extract_gtfs(tmp_path) is True
        assert (
            tmp_path / ".last_modified"
        ).read_text() == "Mon, 02 Nov 2026 10:00:00 GMT"
        assert download_and_extract_gtfs(tmp_path) is False
        assert calls["get"] == 1
