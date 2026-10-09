package main

import (
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeClock returns a controllable clock for deterministic hour boundaries.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// newTestWriter wires a writer with a fake clock starting at start.
func newTestWriter(t *testing.T, dir string, start time.Time) (*ArchiveWriter, *fakeClock) {
	t.Helper()
	clock := &fakeClock{t: start}
	w, err := NewArchiveWriter(dir, clock.now)
	if err != nil {
		t.Fatalf("NewArchiveWriter: %v", err)
	}
	return w, clock
}

// readPlain reads a plain ndjson file into lines.
func readPlain(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return splitLines(data)
}

// readGz reads a gzipped ndjson file into lines.
func readGz(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gzip %s: %v", path, err)
	}
	defer gz.Close()
	data, err := io.ReadAll(gz)
	if err != nil {
		t.Fatalf("read gzip %s: %v", path, err)
	}
	return splitLines(data)
}

func splitLines(data []byte) []string {
	text := strings.TrimSuffix(string(data), "\n")
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

// Two writes in the same hour land in one plain file, byte-identical.
// The active hour stays plain (gzipped only once the hour is over).
func TestWrite_SameHourSingleFile(t *testing.T) {
	dir := t.TempDir()
	w, _ := newTestWriter(t, dir, time.Date(2026, 10, 7, 15, 5, 0, 0, time.UTC))

	if err := w.Write([]byte(`{"vehicle_id":"v1"}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Write([]byte(`{"vehicle_id":"v2"}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	path := filepath.Join(dir, "2026-10-07", "15.ndjson")
	got := readPlain(t, path)
	want := []string{`{"vehicle_id":"v1"}`, `{"vehicle_id":"v2"}`}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("lines = %v, want %v", got, want)
	}

	if _, err := os.Stat(path + ".gz"); !os.IsNotExist(err) {
		t.Errorf("expected no .gz for the active hour, stat err = %v", err)
	}
}

// Crossing the hour closes the old file (gzipped) and opens the next hour.
func TestWrite_HourRollover(t *testing.T) {
	dir := t.TempDir()
	w, clock := newTestWriter(t, dir, time.Date(2026, 10, 7, 15, 59, 0, 0, time.UTC))

	if err := w.Write([]byte(`{"n":1}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	clock.advance(2 * time.Minute) // now 16:01
	if err := w.Write([]byte(`{"n":2}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	if got := readGz(t, filepath.Join(dir, "2026-10-07", "15.ndjson.gz")); len(got) != 1 || got[0] != `{"n":1}` {
		t.Errorf("15.ndjson.gz = %v, want [{\"n\":1}]", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "2026-10-07", "15.ndjson")); !os.IsNotExist(err) {
		t.Errorf("old plain file should be gone after rotation")
	}
	if got := readPlain(t, filepath.Join(dir, "2026-10-07", "16.ndjson")); len(got) != 1 || got[0] != `{"n":2}` {
		t.Errorf("16.ndjson = %v, want [{\"n\":2}]", got)
	}
}

// Crossing midnight rolls into a new date directory.
func TestWrite_MidnightRollover(t *testing.T) {
	dir := t.TempDir()
	w, clock := newTestWriter(t, dir, time.Date(2026, 10, 7, 23, 59, 0, 0, time.UTC))

	if err := w.Write([]byte(`{"n":1}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	clock.advance(2 * time.Minute) // now 00:01 next day
	if err := w.Write([]byte(`{"n":2}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	if got := readGz(t, filepath.Join(dir, "2026-10-07", "23.ndjson.gz")); len(got) != 1 {
		t.Errorf("23.ndjson.gz = %v, want 1 line", got)
	}
	if got := readPlain(t, filepath.Join(dir, "2026-10-08", "00.ndjson")); len(got) != 1 {
		t.Errorf("2026-10-08/00.ndjson = %v, want 1 line", got)
	}
}

// Close keeps the partial hour plain so a restart within the same hour can
// append to it (gzipping at Close would create a second .gz for one hour).
func TestClose_KeepsPlainFileForAppend(t *testing.T) {
	dir := t.TempDir()
	w, _ := newTestWriter(t, dir, time.Date(2026, 10, 7, 15, 5, 0, 0, time.UTC))

	if err := w.Write([]byte(`{"n":1}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	path := filepath.Join(dir, "2026-10-07", "15.ndjson")
	if got := readPlain(t, path); len(got) != 1 || got[0] != `{"n":1}` {
		t.Errorf("after Close, %s = %v, want [{\"n\":1}]", path, got)
	}
	if _, err := os.Stat(path + ".gz"); !os.IsNotExist(err) {
		t.Errorf("no .gz expected right after Close (hour may still be active)")
	}
}

// Restarting within the same hour appends to the existing plain file.
func TestRestart_AppendsSameHour(t *testing.T) {
	dir := t.TempDir()
	start := time.Date(2026, 10, 7, 15, 5, 0, 0, time.UTC)

	w1, _ := newTestWriter(t, dir, start)
	if err := w1.Write([]byte(`{"n":1}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	w2, _ := newTestWriter(t, dir, start.Add(time.Minute))
	if err := w2.Write([]byte(`{"n":2}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w2.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	got := readPlain(t, filepath.Join(dir, "2026-10-07", "15.ndjson"))
	want := []string{`{"n":1}`, `{"n":2}`}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("lines = %v, want %v", got, want)
	}
}

// Startup gzips leftovers from previous runs (crash or shutdown), but only
// for hours that are definitely over — the current hour must stay plain so
// a restart can keep appending (covered by TestRestart_AppendsSameHour).
func TestNew_FinalizesStaleFiles(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "2026-10-05", "03.ndjson")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("{\"n\":1}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Startup runs finalizeStale; newTestWriter fails the test on error.
	newTestWriter(t, dir, time.Date(2026, 10, 7, 15, 0, 0, 0, time.UTC))

	if got := readGz(t, stale+".gz"); len(got) != 1 || got[0] != `{"n":1}` {
		t.Errorf("stale .gz = %v, want [{\"n\":1}]", got)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale plain file should be gone after finalize")
	}
}

// A crash between gzip-rename and plain-removal leaves both files; the next
// startup keeps the complete .gz and just drops the redundant plain file.
func TestNew_PlusGzLeftoverIsDropped(t *testing.T) {
	dir := t.TempDir()
	day := filepath.Join(dir, "2026-10-05")
	if err := os.MkdirAll(day, 0o755); err != nil {
		t.Fatal(err)
	}
	// Complete .gz (as left by an interrupted finalize) + the redundant plain.
	f, err := os.Create(filepath.Join(day, "03.ndjson.gz"))
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	if _, err := gz.Write([]byte("{\"n\":1}\n")); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(day, "03.ndjson"), []byte("{\"n\":1}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	newTestWriter(t, dir, time.Date(2026, 10, 7, 15, 0, 0, 0, time.UTC))

	if got := readGz(t, filepath.Join(day, "03.ndjson.gz")); len(got) != 1 || got[0] != `{"n":1}` {
		t.Errorf(".gz = %v, want [{\"n\":1}]", got)
	}
	if _, err := os.Stat(filepath.Join(day, "03.ndjson")); !os.IsNotExist(err) {
		t.Errorf("redundant plain file should be dropped")
	}
}

// No messages, no files — the writer only creates the root dir at startup.
func TestNoMessages_NoFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "archive")
	w, _ := newTestWriter(t, dir, time.Date(2026, 10, 7, 15, 5, 0, 0, time.UTC))
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected no entries in %s, got %v", dir, entries)
	}
}
