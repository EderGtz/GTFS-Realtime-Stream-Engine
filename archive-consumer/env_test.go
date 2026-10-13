package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A .env file supplies values for unset variables;
func TestLoadDotEnv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := `# comment line

TEST_BROKER=value-one
ARCHIVE_DIR=./from-dotenv
ARCHIVE_AUTO_OFFSET_RESET=earliest
EMPTY_VAR=from-dotenv
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("EMPTY_VAR", "") // set-but-empty must NOT be overwritten
	unsetenv(t, "TEST_BROKER")
	unsetenv(t, "ARCHIVE_DIR")
	unsetenv(t, "ARCHIVE_AUTO_OFFSET_RESET")

	loadDotEnv(path)

	if got := os.Getenv("TEST_BROKER"); got != "value-one" {
		t.Errorf("TEST_BROKER = %q, want value-one", got)
	}
	if got := os.Getenv("EMPTY_VAR"); got != "" {
		t.Errorf("EMPTY_VAR = %q, want empty (set vars are never overwritten)", got)
	}
	if got := os.Getenv("ARCHIVE_DIR"); got != "./from-dotenv" {
		t.Errorf("ARCHIVE_DIR = %q, want ./from-dotenv", got)
	}
	if got := os.Getenv("ARCHIVE_AUTO_OFFSET_RESET"); got != "earliest" {
		t.Errorf("ARCHIVE_AUTO_OFFSET_RESET = %q, want earliest", got)
	}
}

// Real env vars are never overwritten by the file.
func TestLoadDotEnv_RealEnvWins(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("ARCHIVE_DIR=./from-dotenv\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("ARCHIVE_DIR", "/real/value")
	loadDotEnv(path)

	if got := os.Getenv("ARCHIVE_DIR"); got != "/real/value" {
		t.Errorf("ARCHIVE_DIR = %q, want /real/value (real env must win)", got)
	}
}

// A missing .env is silently fine (the compose path has no file at all).
func TestLoadDotEnv_MissingFileIsNoop(t *testing.T) {
	loadDotEnv(filepath.Join(t.TempDir(), "nope", ".env")) // must not panic
}
