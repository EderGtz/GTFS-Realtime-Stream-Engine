//go:build integration

// archive_integration_test.go — real-Kafka integration test (testcontainers,
// KRaft). Proves the three things:
//
//	A) round-trip:   messages published to raw.vehicle-positions land in the
//	   NDJSON archive byte-identical, and the archive-group commits them;
//	B) decoupling:   a second consumer group sees the same messages — two
//	   independent consumers on one topic, without touching ingestion;
//	C) at-least-once: after a restart, the group resumes at its committed
//	   offsets — old messages are NOT redelivered, only new ones are appended.
//
// Run with: go test -tags=integration ./... -v
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/segmentio/kafka-go"
	kafkatest "github.com/testcontainers/testcontainers-go/modules/kafka"
)

const testTopic = "raw.vehicle-positions"

// telemetryJSON builds a message value shaped exactly like
// ingestion-service/src/ingestion/producer.ts publishes (JSON.stringify of
// IVehicleTelemetry + agency_id + ingested_at).
func telemetryJSON(vehicleID string) string {
	return fmt.Sprintf(
		`{"agency_id":"mbta","vehicle_id":%q,"trip_id":"trip-1","route_id":"28","direction_id":0,`+
			`"location":{"type":"Point","coordinates":[-71.06,42.35]},"timestamp":"2026-10-12T10:00:00.000Z",`+
			`"bearing":90,"speed":5.5,"current_stop_sequence":3,"stop_id":"stop-1",`+
			`"current_status":"IN_TRANSIT_TO","ingested_at":"2026-10-12T10:00:01.000Z"}`,
		vehicleID,
	)
}

// publish writes values to the topic, keyed by vehicle_id like producer.ts.
func publish(t *testing.T, brokers []string, values []string) {
	t.Helper()
	w := &kafka.Writer{
		Addr:  kafka.TCP(brokers...),
		Topic: testTopic,
	}
	defer w.Close()

	msgs := make([]kafka.Message, len(values))
	for i, v := range values {
		msgs[i] = kafka.Message{Key: []byte("v"), Value: []byte(v)}
	}
	if err := w.WriteMessages(context.Background(), msgs...); err != nil {
		t.Fatalf("publish: %v", err)
	}
}

// newGroupReader creates a consumer in its own group
func newGroupReader(brokers []string, group string) *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers:     brokers,
		Topic:       testTopic,
		GroupID:     group,
		MinBytes:    1,
		MaxBytes:    10e6,
		MaxWait:     250 * time.Millisecond,
		StartOffset: kafka.FirstOffset,
	})
}

// findLines returns every archived line across all hour files.
func findLines(t *testing.T, dir string) []string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(dir, "*", "*.ndjson"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	sort.Strings(matches)
	var lines []string
	for _, path := range matches {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
			if line != "" {
				lines = append(lines, line)
			}
		}
	}
	return lines
}

// waitForLines polls the archive dir until at least want lines exist.
func waitForLines(t *testing.T, dir string, want int) []string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		lines := findLines(t, dir)
		if len(lines) >= want {
			return lines
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d archived lines, got %v", want, findLines(t, dir))
	return nil
}

// waitReady polls the broker's metadata API until it answers (the group
// coordinator takes a moment to come up in KRaft mode).
func waitReady(t *testing.T, brokers []string) {
	t.Helper()
	client := &kafka.Client{Addr: kafka.TCP(brokers...)}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, err := client.Metadata(ctx, &kafka.MetadataRequest{Topics: []string{testTopic}})
		cancel()
		if err == nil {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatal("Kafka did not become ready within 30s")
}

// runArchive runs the real consume loop (Run + ArchiveWriter) until want
// lines are archived, then shuts it down cleanly. Returns the error Run
// exited with (nil on clean cancellation).
func runArchive(t *testing.T, brokers []string, dir string, want int) error {
	t.Helper()
	writer, err := NewArchiveWriter(dir, time.Now)
	if err != nil {
		t.Fatalf("NewArchiveWriter: %v", err)
	}
	reader := newGroupReader(brokers, "archive-group")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Run(ctx, reader, writer, 50, 300*time.Millisecond) }()

	waitForLines(t, dir, want)
	cancel()
	err = <-done

	// Close the reader so it LEAVES the consumer group. A still-open reader
	// keeps its group membership after Run returns, and the next runArchive
	// would share partitions with this dead one — the new reader could miss
	// messages assigned to it (source of a nasty flake).
	if cerr := reader.Close(); cerr != nil {
		t.Errorf("reader.Close: %v", cerr)
	}
	return err
}

func TestArchiveIntegration(t *testing.T) {
	ctx := context.Background()

	kc, err := kafkatest.RunContainer(ctx)
	if err != nil {
		t.Fatalf("start Kafka container: %v", err)
	}
	defer func() { _ = kc.Terminate(context.Background()) }()

	brokers, err := kc.Brokers(ctx)
	if err != nil {
		t.Fatalf("brokers: %v", err)
	}

	// Create the topic explicitly with 4 partitions — auto-create is disabled
	// in production (docker-compose.yml), so the test shouldn't rely on it.
	client := &kafka.Client{Addr: kafka.TCP(brokers...)}
	if _, err := client.CreateTopics(ctx, &kafka.CreateTopicsRequest{
		Topics: []kafka.TopicConfig{{
			Topic:             testTopic,
			NumPartitions:     4,
			ReplicationFactor: 1,
		}},
	}); err != nil {
		t.Fatalf("create topic: %v", err)
	}
	waitReady(t, brokers)

	dir := t.TempDir()
	values := []string{telemetryJSON("bus-1"), telemetryJSON("bus-2"), telemetryJSON("bus-3")}

	// ── Phase A: round-trip into the NDJSON archive ────────────────────────
	publish(t, brokers, values)
	if err := runArchive(t, brokers, dir, 3); err != nil {
		t.Fatalf("Run (phase A) returned error: %v", err)
	}

	lines := findLines(t, dir)
	if len(lines) != 3 {
		t.Fatalf("archived %d lines, want 3: %v", len(lines), lines)
	}
	archived := map[string]bool{}
	for _, l := range lines {
		archived[l] = true
	}
	for _, v := range values {
		// Byte-identical: each line IS the message producer.ts published.
		if !archived[v] {
			t.Errorf("value not archived verbatim: %s", v)
		}
	}

	// ── Phase B: decoupling — a second group gets the same messages ────────
	r2 := newGroupReader(brokers, "analytics-engine-test")
	defer r2.Close()
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		rctx, rcancel := context.WithTimeout(ctx, 15*time.Second)
		msg, err := r2.ReadMessage(rctx)
		rcancel()
		if err != nil {
			t.Fatalf("second group read %d: %v", i, err)
		}
		seen[string(msg.Value)] = true
	}
	for _, v := range values {
		if !seen[v] {
			t.Errorf("second group did not receive: %s", v)
		}
	}

	// ── Phase C: restart resumes at committed offsets (no redelivery) ──────
	fourth := telemetryJSON("bus-4")
	publish(t, brokers, []string{fourth})
	if err := runArchive(t, brokers, dir, 4); err != nil {
		t.Fatalf("Run (phase C) returned error: %v", err)
	}

	lines = findLines(t, dir)
	// Exactly 4: the original 3 were committed before phase A ended, so the
	// restarted group did NOT see them again. More than 4 = redelivery (the
	// offset commit is broken); fewer = data loss.
	if len(lines) != 4 {
		t.Fatalf("after restart: %d archived lines, want 4: %v", len(lines), lines)
	}
	if lines[3] != fourth {
		t.Errorf("4th line = %s, want the new message", lines[3])
	}
}
