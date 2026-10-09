// Go program that joins the existing `raw.vehicle-positions` Kafka
// topic as a second consumer group (`archive-group`) and appends
// every message to date-partitioned NDJSON files on disk. It deliberately does
// zero transformation, so the message value produced by
// ingestion-service/src/ingestion/producer.ts is written to disk verbatim.
package main

import (
	"fmt"
	"os"
	"strings"
)

// Config holds everything the service needs to run. Read once at startup by
// Load(); nothing else in the service touches os.Getenv directly.
type Config struct {
	// Kafka bootstrap list
	Brokers []string

	// Default "raw.vehicle-positions"
	Topic string

	// Default "archive-group"
	GroupID string

	// ArchiveDir is the output root. Files land in
	//   <ArchiveDir>/YYYY-MM-DD/HH.ndjson     (active hour, plain)
	//   <ArchiveDir>/YYYY-MM-DD/HH.ndjson.gz  (closed hours, gzipped)
	// UTC dates/hours, see writer.go for the rotation rationale.
	// Default "./data/archive" (repo-root layout from the roadmap).
	ArchiveDir string

	// Default "latest"
	AutoOffsetReset string
}

var validOffsetResets = map[string]struct{}{
	"earliest": struct{}{},
	"latest":   struct{}{},
}

func envOrThrow(key string) (string, error) {
	value := os.Getenv(key)
	if value == "" {
		return "", fmt.Errorf("could not find mandatory environment variable: %s", key)
	}
	return value, nil
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

// Load reads configuration from the environment
func Load() (Config, error) {
	brokersRaw, err := envOrThrow("KAFKA_BROKERS")
	if err != nil {
		return Config{}, err
	}

	// Accept "host1:port1,host2:port2"
	var brokers []string
	for _, b := range strings.Split(brokersRaw, ",") {
		if trimmed := strings.TrimSpace(b); trimmed != "" {
			brokers = append(brokers, trimmed)
		}
	}
	if len(brokers) == 0 {
		return Config{}, fmt.Errorf("KAFKA_BROKERS contains no broker addresses: %q", brokersRaw)
	}

	cfg := Config{
		Brokers:         brokers,
		Topic:           envOrDefault("KAFKA_TOPIC", "raw.vehicle-positions"),
		GroupID:         envOrDefault("KAFKA_GROUP_ID", "archive-group"),
		ArchiveDir:      envOrDefault("ARCHIVE_DIR", "./data/archive"),
		AutoOffsetReset: envOrDefault("ARCHIVE_AUTO_OFFSET_RESET", "latest"),
	}

	if _, ok := validOffsetResets[cfg.AutoOffsetReset]; !ok {
		return Config{}, fmt.Errorf(
			"invalid ARCHIVE_AUTO_OFFSET_RESET %q: must be \"earliest\" or \"latest\"",
			cfg.AutoOffsetReset,
		)
	}

	return cfg, nil
}
