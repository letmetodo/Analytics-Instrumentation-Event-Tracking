package abi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// RotateMode defines whether LoggerConsumer rotates files daily or hourly.
type RotateMode string

const (
	RotateDaily  RotateMode = "DAILY"
	RotateHourly RotateMode = "HOURLY"
)

// LoggerConfig configures LoggerConsumer for local disk JSONL persistence (for Filebeat / Vector / LogBus).
type LoggerConfig struct {
	Directory     string
	FilePrefix    string
	RotateMode    RotateMode
	MaxFileSizeMB int
	NowFunc       func() time.Time
}

// LoggerConsumer writes validated events as newline-delimited JSON (JSONL) to rotating local files.
type LoggerConsumer struct {
	cfg           LoggerConfig
	mu            sync.Mutex
	currentPeriod string
	currentIndex  int
	currentBytes  int64
	file          *os.File
	closed        bool
}

// NewLoggerConsumer creates a local rotating file consumer.
func NewLoggerConsumer(cfg LoggerConfig) (*LoggerConsumer, error) {
	if cfg.Directory == "" {
		return nil, fmt.Errorf("Directory is required for LoggerConsumer")
	}
	if cfg.FilePrefix == "" {
		cfg.FilePrefix = "abi.log"
	}
	if cfg.RotateMode == "" {
		cfg.RotateMode = RotateDaily
	}
	if cfg.NowFunc == nil {
		cfg.NowFunc = time.Now
	}
	if err := os.MkdirAll(cfg.Directory, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", cfg.Directory, err)
	}
	return &LoggerConsumer{cfg: cfg}, nil
}

// Add writes a single event JSON line to the active log file.
func (l *LoggerConsumer) Add(event TrackEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	line := append(data, '\n')

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return fmt.Errorf("logger consumer is closed")
	}

	if err := l.ensureFileLocked(int64(len(line))); err != nil {
		return err
	}
	n, err := l.file.Write(line)
	l.currentBytes += int64(n)
	return err
}

func (l *LoggerConsumer) ensureFileLocked(incomingBytes int64) error {
	now := l.cfg.NowFunc()
	periodLayout := "2006-01-02"
	if l.cfg.RotateMode == RotateHourly {
		periodLayout = "2006-01-02-15"
	}
	period := now.Format(periodLayout)
	maxBytes := int64(l.cfg.MaxFileSizeMB) * 1024 * 1024

	needRotate := l.file == nil || l.currentPeriod != period ||
		(maxBytes > 0 && l.currentBytes+incomingBytes > maxBytes)
	if !needRotate {
		return nil
	}

	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
	if l.currentPeriod != period {
		l.currentPeriod = period
		l.currentIndex = 0
	} else {
		l.currentIndex++
	}

	fileName := fmt.Sprintf("%s.%s", l.cfg.FilePrefix, l.currentPeriod)
	if l.currentIndex > 0 {
		fileName = fmt.Sprintf("%s.%s_%d", l.cfg.FilePrefix, l.currentPeriod, l.currentIndex)
	}
	fullPath := filepath.Join(l.cfg.Directory, fileName)
	f, err := os.OpenFile(fullPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open log file %s: %w", fullPath, err)
	}
	info, err := f.Stat()
	if err == nil {
		l.currentBytes = info.Size()
	} else {
		l.currentBytes = 0
	}
	l.file = f
	return nil
}

// Flush syncs the underlying file descriptor to disk.
func (l *LoggerConsumer) Flush() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		return l.file.Sync()
	}
	return nil
}

// Close flushes and closes the active log file.
func (l *LoggerConsumer) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	if l.file != nil {
		_ = l.file.Sync()
		err := l.file.Close()
		l.file = nil
		return err
	}
	return nil
}
