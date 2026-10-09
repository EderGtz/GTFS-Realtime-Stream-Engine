// NDJSON archive writer with hourly rotation and gzip finalization
// Writes one raw Kafka message value per line verbatim to
// <dir>/YYYY-MM-DD/HH.ndjson (UTC). The active hour's file stays plain so a
// crash never corrupts it and a restart can append; each file is gzipped to
// .ndjson.gz exactly once, when its hour is definitely over.
package main

import (
	"bufio"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// ArchiveWriter owns the currently open hour file. One instance equals one writer
// process; the directory is single-writer.
type ArchiveWriter struct {
	dir string
	now func() time.Time // injectable clock for tests

	// curKey is the open-or-about-to-open hour ("<YYYY-MM-DD>/<HH>"), set even
	// before the file is opened so the current hour is never finalized.
	curKey  string
	curFile *os.File
	buf     *bufio.Writer
}

// NewArchiveWriter creates the output dir and finalizes (gzips) leftovers from
// previous runs, except the current hour, which a restart may append to.
func NewArchiveWriter(dir string, now func() time.Time) (*ArchiveWriter, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create archive dir: %w", err)
	}
	w := &ArchiveWriter{
		dir:    dir,
		now:    now,
		curKey: hourKey(now().UTC())}
	if err := w.finalizeStale(); err != nil {
		return nil, err
	}
	return w, nil
}

// Write appends one message value as a single NDJSON line, rotating files when
// the hour changes.
func (w *ArchiveWriter) Write(value []byte) error {
	key := hourKey(w.now().UTC())
	if key != w.curKey || w.curFile == nil {
		if err := w.rotate(key); err != nil {
			return err
		}
	}
	if _, err := w.buf.Write(value); err != nil {
		return fmt.Errorf("write line: %w", err)
	}
	return w.buf.WriteByte('\n')
}

// Flush pushes buffered data to the OS (fsync). Callers rely on this before
// committing Kafka offsets (nothing is committed until durable).
func (w *ArchiveWriter) Flush() error {
	if w.curFile == nil {
		return nil
	}
	if err := w.buf.Flush(); err != nil {
		return fmt.Errorf("flush buffer: %w", err)
	}
	if err := w.curFile.Sync(); err != nil {
		return fmt.Errorf("fsync: %w", err)
	}
	return nil
}

// Close flushes and closes the active file, leaving it plain: the hour may not
// be over yet, and a plain file can still be appended to after a restart.
func (w *ArchiveWriter) Close() error {
	if w.curFile == nil {
		return nil
	}
	if err := w.buf.Flush(); err != nil {
		return fmt.Errorf("flush buffer: %w", err)
	}
	err := w.curFile.Close()
	w.curFile = nil
	if err != nil {
		return fmt.Errorf("close file: %w", err)
	}
	return nil
}

// rotate closes the current hour (if any) and opens the given hour's file.
func (w *ArchiveWriter) rotate(key string) error {
	if w.curFile != nil {
		if err := w.Close(); err != nil {
			return err
		}
	}

	path := filepath.Join(w.dir, key+".ndjson")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create date dir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open hour file: %w", err)
	}

	w.curFile = f
	w.buf = bufio.NewWriter(f)
	w.curKey = key

	// The hour just closed (and any older leftovers) is now stale → gzipped.
	return w.finalizeStale()
}

// finalizeStale gzips every plain hour file except the current hour's.
func (w *ArchiveWriter) finalizeStale() error {
	matches, err := filepath.Glob(filepath.Join(w.dir, "*", "*.ndjson"))
	if err != nil {
		return fmt.Errorf("glob archive files: %w", err)
	}
	for _, path := range matches {
		if path == filepath.Join(w.dir, w.curKey+".ndjson") {
			continue
		}
		if err := gzipFile(path); err != nil {
			return err
		}
	}
	return nil
}

// gzipFile compresses one plain hour file to <path>.gz and removes the plain
// original. Uses tmp + rename so a crash can never leave a truncated .gz at
// the final name; if a complete .gz already exists (crash between rename and
// removal), the plain file is simply dropped.
func gzipFile(path string) error {
	gzPath := path + ".gz"

	if _, err := os.Stat(gzPath); err == nil {
		return os.Remove(path)
	}

	src, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer src.Close()

	tmp := gzPath + ".tmp"
	dst, err := os.Create(tmp)
	if err != nil {
		return fmt.Errorf("create %s: %w", tmp, err)
	}
	gz := gzip.NewWriter(dst)
	if _, err := io.Copy(gz, src); err != nil {
		dst.Close()
		os.Remove(tmp)
		return fmt.Errorf("compress %s: %w", path, err)
	}
	if err := gz.Close(); err != nil {
		dst.Close()
		os.Remove(tmp)
		return fmt.Errorf("close gzip %s: %w", path, err)
	}
	if err := dst.Close(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("close %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, gzPath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename %s: %w", tmp, err)
	}
	return os.Remove(path)
}

// hourKey formats a UTC time as the relative file path "<YYYY-MM-DD>/<HH>".
func hourKey(t time.Time) string {
	return t.Format("2006-01-02/15")
}
