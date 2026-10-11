// archive_test.go — tests for the consume loop: batch write → flush/fsync →
// commit, at-least-once commit gating, batch timeout, clean shutdown.
package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/segmentio/kafka-go"
)

// stubFetcher serves queued messages, then blocks until ctx ends (like a real
// Kafka reader with no traffic). Records every commit.
type stubFetcher struct {
	mu       sync.Mutex
	queue    []kafka.Message
	fetchErr error
	commits  [][]kafka.Message
	commitCh chan []kafka.Message // buffered; one send per commit
	record   func(string)         // optional ordering log (thread-safe impl)
}

func (s *stubFetcher) FetchMessage(ctx context.Context) (kafka.Message, error) {
	s.mu.Lock()
	if s.fetchErr != nil {
		err := s.fetchErr
		s.mu.Unlock()
		return kafka.Message{}, err
	}
	if len(s.queue) > 0 {
		m := s.queue[0]
		s.queue = s.queue[1:]
		s.mu.Unlock()
		return m, nil
	}
	s.mu.Unlock()
	<-ctx.Done() // no traffic: wait for batch timeout or shutdown
	return kafka.Message{}, ctx.Err()
}

func (s *stubFetcher) CommitMessages(ctx context.Context, msgs ...kafka.Message) error {
	s.mu.Lock()
	s.commits = append(s.commits, msgs)
	rec := s.record
	s.mu.Unlock()

	if rec != nil {
		rec("commit")
	}
	if s.commitCh != nil {
		select {
		case s.commitCh <- msgs:
		default:
		}
	}
	return nil
}

// stubWriter records lines; can fail writes on demand.
type stubWriter struct {
	mu       sync.Mutex
	lines    [][]byte
	writeErr error
	flushed  int
	closed   bool
	record   func(string)
}

func (w *stubWriter) Write(value []byte) error {
	w.mu.Lock()
	if w.writeErr != nil {
		err := w.writeErr
		w.mu.Unlock()
		return err
	}
	w.lines = append(w.lines, append([]byte(nil), value...))
	rec := w.record
	w.mu.Unlock()

	if rec != nil {
		rec("write")
	}
	return nil
}

func (w *stubWriter) Flush() error {
	w.mu.Lock()
	w.flushed++
	rec := w.record
	w.mu.Unlock()

	if rec != nil {
		rec("flush")
	}
	return nil
}

func (w *stubWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	return nil
}

// runAsync starts Run in a goroutine and returns a channel with its result.
func runAsync(ctx context.Context, r messageFetcher, w lineWriter, batchSize int, batchWait time.Duration) <-chan error {
	done := make(chan error, 1)
	go func() { done <- Run(ctx, r, w, batchSize, batchWait) }()
	return done
}

// waitOrFail waits for a value on ch or fails the test after 2s.
func waitOrFail[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		panic("unreachable")
	}
}

// Full batch: every message written, then ONE flush and ONE commit of the
// whole batch, in that order (nothing committed before it is durable).
func TestRun_CommitsAfterFlush(t *testing.T) {
	var mu sync.Mutex
	var events []string
	record := func(e string) { mu.Lock(); events = append(events, e); mu.Unlock() }

	fetcher := &stubFetcher{
		queue: []kafka.Message{
			{Value: []byte(`{"n":1}`), Offset: 0},
			{Value: []byte(`{"n":2}`), Offset: 1},
			{Value: []byte(`{"n":3}`), Offset: 2},
		},
		commitCh: make(chan []kafka.Message, 4),
		record:   record,
	}
	writer := &stubWriter{record: record}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := runAsync(ctx, fetcher, writer, 3, time.Second)

	commits := waitOrFail(t, fetcher.commitCh, "commit")
	if len(commits) != 3 {
		t.Errorf("commit size = %d, want 3", len(commits))
	}
	if len(writer.lines) != 3 {
		t.Errorf("written lines = %d, want 3", len(writer.lines))
	}

	cancel()
	if err := waitOrFail(t, done, "Run to return"); err != nil {
		t.Errorf("Run returned %v, want nil", err)
	}

	mu.Lock()
	got := strings.Join(events, ",")
	mu.Unlock()
	want := "write,write,write,flush,commit"
	if got != want {
		t.Errorf("event order = %q, want %q", got, want)
	}
}

// A batch that never fills is flushed after batchWait (bounded latency).
func TestRun_PartialBatchFlushesOnTimeout(t *testing.T) {
	fetcher := &stubFetcher{
		queue:    []kafka.Message{{Value: []byte(`{"n":1}`), Offset: 0}},
		commitCh: make(chan []kafka.Message, 4),
	}
	writer := &stubWriter{}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := runAsync(ctx, fetcher, writer, 50, 30*time.Millisecond)

	commits := waitOrFail(t, fetcher.commitCh, "commit")
	if len(commits) != 1 {
		t.Errorf("commit size = %d, want 1", len(commits))
	}
	if len(writer.lines) != 1 {
		t.Errorf("written lines = %d, want 1", len(writer.lines))
	}

	cancel()
	if err := waitOrFail(t, done, "Run to return"); err != nil {
		t.Errorf("Run returned %v, want nil", err)
	}
}

// A write failure must NOT commit: uncommitted messages get redelivered after
// restart (at-least-once), committed-but-unwritten ones would be lost.
func TestRun_WriteErrorSkipsCommit(t *testing.T) {
	fetcher := &stubFetcher{
		queue:    []kafka.Message{{Value: []byte(`{"n":1}`), Offset: 0}},
		commitCh: make(chan []kafka.Message, 4),
	}
	writer := &stubWriter{writeErr: errors.New("disk full")}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := runAsync(ctx, fetcher, writer, 1, time.Second)

	err := waitOrFail(t, done, "Run to return")
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Errorf("Run error = %v, want it to wrap 'disk full'", err)
	}
	fetcher.mu.Lock()
	n := len(fetcher.commits)
	fetcher.mu.Unlock()
	if n != 0 {
		t.Errorf("commits = %d, want 0 (nothing committed after write failure)", n)
	}
	if !writer.closed {
		t.Errorf("writer should be closed on error return")
	}
}

// Cancel (Ctrl+C / SIGTERM path): clean nil return, writer closed, no commit
// of the unwritten partial batch (redelivered on restart instead).
func TestRun_CancelShutsDownCleanly(t *testing.T) {
	fetcher := &stubFetcher{commitCh: make(chan []kafka.Message, 4)}
	writer := &stubWriter{}

	ctx, cancel := context.WithCancel(context.Background())
	done := runAsync(ctx, fetcher, writer, 50, time.Second)
	cancel()

	if err := waitOrFail(t, done, "Run to return"); err != nil {
		t.Errorf("Run returned %v, want nil on cancellation", err)
	}
	if !writer.closed {
		t.Errorf("writer should be closed on shutdown")
	}
	fetcher.mu.Lock()
	n := len(fetcher.commits)
	fetcher.mu.Unlock()
	if n != 0 {
		t.Errorf("commits = %d, want 0", n)
	}
}

// A fetch failure (broker gone, fatal rebalance error) propagates so the
// process can exit loudly and restart.
func TestRun_FetchErrorPropagates(t *testing.T) {
	fetcher := &stubFetcher{fetchErr: errors.New("broker unreachable"), commitCh: make(chan []kafka.Message, 4)}
	writer := &stubWriter{}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := runAsync(ctx, fetcher, writer, 50, time.Second)

	err := waitOrFail(t, done, "Run to return")
	if err == nil || !strings.Contains(err.Error(), "broker unreachable") {
		t.Errorf("Run error = %v, want 'broker unreachable'", err)
	}
}

// Bad batch parameters fail fast instead of deadlocking at runtime.
func TestRun_RejectsBadBatchParams(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := Run(ctx, &stubFetcher{}, &stubWriter{}, 0, time.Second); err == nil {
		t.Error("expected error for batchSize=0")
	}
	if err := Run(ctx, &stubFetcher{}, &stubWriter{}, 1, 0); err == nil {
		t.Error("expected error for batchWait=0")
	}
}
