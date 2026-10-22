package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/segmentio/kafka-go"
)

const (
	batchSize = 500
	batchWait = time.Second
)

// countingWriter wraps the archive writer to count lines/bytes for the
// once-a-minute stats log (log-only metrics; no metrics system here).
type countingWriter struct {
	inner lineWriter
	lines atomic.Int64
	bytes atomic.Int64
}

func (c *countingWriter) Write(value []byte) error {
	if err := c.inner.Write(value); err != nil {
		return err
	}
	c.lines.Add(1)
	c.bytes.Add(int64(len(value)))
	return nil
}

func (c *countingWriter) Flush() error { return c.inner.Flush() }

func (c *countingWriter) Close() error { return c.inner.Close() }

// wires config, the NDJSON writer, the Kafka reader,
// and the consume loop (archive.go), with graceful shutdown on SIGTERM/SIGINT.
func main() {
	loadDotEnv(".env")

	cfg, err := Load()
	if err != nil {
		slog.Error("configuration error", "err", err)
		os.Exit(1)
	}

	slog.Info("starting archive-consumer",
		"brokers", cfg.Brokers,
		"topic", cfg.Topic,
		"group", cfg.GroupID,
		"dir", cfg.ArchiveDir,
		"auto_offset_reset", cfg.AutoOffsetReset,
	)

	writer, err := NewArchiveWriter(cfg.ArchiveDir, time.Now)
	if err != nil {
		slog.Error("archive writer failed", "err", err)
		os.Exit(1)
	}

	// StartOffset only matters when the group has no committed offset yet
	// (first ever run): "latest" = start at the tail, "earliest" = replay
	// everything Kafka still retains. Every later run resumes from its own
	// committed offsets regardless of this setting.
	startOffset := kafka.LastOffset
	if cfg.AutoOffsetReset == "earliest" {
		startOffset = kafka.FirstOffset
	}

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:     cfg.Brokers,
		Topic:       cfg.Topic,
		GroupID:     cfg.GroupID,
		MinBytes:    1,
		MaxBytes:    10e6,
		MaxWait:     500 * time.Millisecond,
		StartOffset: startOffset,
	})
	defer reader.Close()

	// SIGTERM (docker stop) and SIGINT (Ctrl+C) both cancel ctx, which drives
	// the same clean shutdown path in Run (see archive.go).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	counter := &countingWriter{inner: writer}
	touchHeartbeat()
	go logStats(ctx, counter)

	if err := Run(ctx, reader, counter, batchSize, batchWait); err != nil {
		slog.Error("archive loop failed", "err", err)
		os.Exit(1)
	}
	slog.Info("shutdown complete")
}

// logStats logs cumulative archive counts once a minute until ctx ends, and
// refreshes the liveness heartbeat file the compose healthcheck watches.
func logStats(ctx context.Context, c *countingWriter) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			touchHeartbeat()
			slog.Info("archive stats", "lines", c.lines.Load(), "bytes", c.bytes.Load())
		}
	}
}

// touchHeartbeat marks the process alive for the compose healthcheck
// (liveness only — a quiet topic must not look unhealthy).
func touchHeartbeat() {
	_ = os.WriteFile("/tmp/archive-heartbeat", []byte(time.Now().UTC().Format(time.RFC3339)), 0o644)
}
