// archive.go drives the consume loop: fetch messages from Kafka in batches, write
// each to the NDJSON archive, and only commit offsets once the batch is
// durable on disk in order to ensure that a crash redelivers the uncommitted batch,
// which may duplicate lines but never loses data.
package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

// slice of *kafka.Reader
type messageFetcher interface {
	FetchMessage(ctx context.Context) (kafka.Message, error)
	CommitMessages(ctx context.Context, msgs ...kafka.Message) error
}

// slice of *ArchiveWriter: Write one value, Flush to disk, Close on exit.
type lineWriter interface {
	Write(value []byte) error
	Flush() error
	Close() error
}

// Run consumes until ctx is cancelled (wich returns nil the) or a write/commit
// fails (returns the error; Docker's restart policy restarts the service).
//
// Batching: up to batchSize messages or batchWait, whichever comes first.
// batchWait bounds how long a low-traffic batch sits in memory unwritten.
// A batch is always written AND fsynced before its offsets are committed;
// on any write/flush error nothing is committed, so Kafka redelivers.
func Run(ctx context.Context, r messageFetcher, w lineWriter, batchSize int, batchWait time.Duration) error {
	if batchSize <= 0 {
		return fmt.Errorf("batchSize must be > 0, got %d", batchSize)
	}
	if batchWait <= 0 {
		return fmt.Errorf("batchWait must be > 0, got %v", batchWait)
	}
	defer w.Close()

	batch := make([]kafka.Message, 0, batchSize)
	var deadline time.Time // zero until the first message of a batch arrives

	for {
		if len(batch) >= batchSize {
			if err := flushBatch(ctx, w, r, batch); err != nil {
				return err
			}
			batch = batch[:0] // to empty the slice
			deadline = time.Time{}
			continue
		}

		// Once a batch is open, bound the wait for the next message so a
		// partial batch still reaches disk within batchWait.
		fetchCtx := ctx
		stop := func() {}
		if !deadline.IsZero() {
			fetchCtx, stop = context.WithDeadline(ctx, deadline)
		}
		msg, err := r.FetchMessage(fetchCtx)
		stop()

		if err != nil {
			if ctx.Err() != nil {
				// Shutdown: the partial batch is NOT committed
				return nil
			}
			if !deadline.IsZero() && ctx.Err() == nil && isDeadline(err) {
				// batchWait elapsed with a partial batch → flush what we have.
				if ferr := flushBatch(ctx, w, r, batch); ferr != nil {
					return ferr
				}
				batch = batch[:0]
				deadline = time.Time{}
				continue
			}
			return fmt.Errorf("fetch message: %w", err)
		}

		if len(batch) == 0 {
			deadline = time.Now().Add(batchWait)
		}
		batch = append(batch, msg)
	}
}

// flushBatch writes every message, fsyncs, then commits the batch's offsets.
// Commit only happens after the durable flush.
func flushBatch(ctx context.Context, w lineWriter, r messageFetcher, batch []kafka.Message) error {
	for _, msg := range batch {
		if err := w.Write(msg.Value); err != nil {
			return fmt.Errorf("write to archive: %w", err) // redeliver
		}
	}
	if err := w.Flush(); err != nil {
		return fmt.Errorf("flush archive: %w", err) // redeliver
	}
	if err := r.CommitMessages(ctx, batch...); err != nil {
		// Written but uncommitted → duplicated after restart.
		return fmt.Errorf("commit offsets: %w", err)
	}
	return nil
}

// isDeadline reports whether err is a batch-window timeout (vs. a real error).
func isDeadline(err error) bool {
	return errors.Is(err, context.DeadlineExceeded)
}
