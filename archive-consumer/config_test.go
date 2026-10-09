package main

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func unsetenv(t *testing.T, key string) {
	t.Helper()
	prev, existed := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("unsetenv(%s): %v", key, err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(key, prev) // restore for other tests
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

func clearOptionalEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"KAFKA_TOPIC", "KAFKA_GROUP_ID", "ARCHIVE_DIR", "ARCHIVE_AUTO_OFFSET_RESET"} {
		unsetenv(t, key)
	}
}

func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		envs    map[string]string
		wantErr bool
	}{
		{
			name:    "missing brokers",
			envs:    map[string]string{},
			wantErr: true,
		},
		{
			name:    "empty brokers string",
			envs:    map[string]string{"KAFKA_BROKERS": " , , "},
			wantErr: true,
		},
		{
			name: "invalid offset reset",
			envs: map[string]string{
				"KAFKA_BROKERS":             "localhost:9092",
				"ARCHIVE_AUTO_OFFSET_RESET": "sometime-never",
			},
			wantErr: true,
		},
		{
			name: "valid minimal config",
			envs: map[string]string{
				"KAFKA_BROKERS": "localhost:9092",
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for k, v := range tt.envs {
				t.Setenv(k, v)
			}

			_, err := Load()
			if (err != nil) != tt.wantErr {
				t.Fatalf("Load() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestLoad_Defaults(t *testing.T) {
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	clearOptionalEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got, want := cfg.Brokers, []string{"localhost:9092"}; !reflect.DeepEqual(got, want) {
		t.Errorf("Brokers = %v, want %v", got, want)
	}
	if got, want := cfg.Topic, "raw.vehicle-positions"; got != want {
		t.Errorf("Topic = %q, want %q", got, want)
	}
	if got, want := cfg.GroupID, "archive-group"; got != want {
		t.Errorf("GroupID = %q, want %q", got, want)
	}
	if got, want := cfg.ArchiveDir, "./data/archive"; got != want {
		t.Errorf("ArchiveDir = %q, want %q", got, want)
	}
	if got, want := cfg.AutoOffsetReset, "latest"; got != want {
		t.Errorf("AutoOffsetReset = %q, want %q", got, want)
	}
}

func TestLoad_AllEnvVarsOverride(t *testing.T) {
	t.Setenv("KAFKA_BROKERS", "kafka:29092")
	t.Setenv("KAFKA_TOPIC", "test.topic")
	t.Setenv("KAFKA_GROUP_ID", "test-group")
	t.Setenv("ARCHIVE_DIR", "/data/archive")
	t.Setenv("ARCHIVE_AUTO_OFFSET_RESET", "earliest")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if got, want := cfg.Topic, "test.topic"; got != want {
		t.Errorf("Topic = %q, want %q", got, want)
	}
	if got, want := cfg.GroupID, "test-group"; got != want {
		t.Errorf("GroupID = %q, want %q", got, want)
	}
	if got, want := cfg.ArchiveDir, "/data/archive"; got != want {
		t.Errorf("ArchiveDir = %q, want %q", got, want)
	}
	if got, want := cfg.AutoOffsetReset, "earliest"; got != want {
		t.Errorf("AutoOffsetReset = %q, want %q", got, want)
	}
}

func TestLoad_EarliestAccepted(t *testing.T) {
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("ARCHIVE_AUTO_OFFSET_RESET", "earliest")
	unsetenv(t, "KAFKA_TOPIC")
	unsetenv(t, "KAFKA_GROUP_ID")
	unsetenv(t, "ARCHIVE_DIR")

	if _, err := Load(); err != nil {
		t.Fatalf("unexpected error for ARCHIVE_AUTO_OFFSET_RESET=earliest: %v", err)
	}
}

func TestLoad_InvalidAutoOffsetResetRejected(t *testing.T) {
	t.Setenv("KAFKA_BROKERS", "localhost:9092")
	t.Setenv("ARCHIVE_AUTO_OFFSET_RESET", "yesterday")
	unsetenv(t, "KAFKA_TOPIC")
	unsetenv(t, "KAFKA_GROUP_ID")
	unsetenv(t, "ARCHIVE_DIR")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for ARCHIVE_AUTO_OFFSET_RESET=yesterday, got nil")
	}
	if !strings.Contains(err.Error(), "ARCHIVE_AUTO_OFFSET_RESET") {
		t.Errorf("error should name the bad variable, got: %v", err)
	}
}
