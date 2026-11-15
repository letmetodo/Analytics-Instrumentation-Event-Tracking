package abi

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// BatchConfig configures BatchConsumer for high-throughput HTTP batch ingestion.
type BatchConfig struct {
	ServerURL     string
	ProjectID     int64
	ProjectToken  string
	BatchSize     int
	FlushInterval time.Duration
	MaxCacheSize  int
	Timeout       time.Duration
	MaxRetries    int
	CompressGzip  bool
	HTTPClient    *http.Client
	OnError       func(err error, droppedEvents []TrackEvent)
}

// BatchConsumer buffers events in memory and sends batches to the ABI Ingest Gateway.
type BatchConsumer struct {
	cfg      BatchConfig
	endpoint string
	client   *http.Client

	mu      sync.Mutex
	buffer  []TrackEvent
	closed  bool
	flushCh chan struct{}
	stopCh  chan struct{}
	doneCh  chan struct{}
}

// NewBatchConsumer creates and starts a background-flushing BatchConsumer.
func NewBatchConsumer(cfg BatchConfig) (*BatchConsumer, error) {
	if strings.TrimSpace(cfg.ServerURL) == "" {
		return nil, fmt.Errorf("ServerURL is required")
	}
	if cfg.ProjectID <= 0 || strings.TrimSpace(cfg.ProjectToken) == "" {
		return nil, fmt.Errorf("ProjectID and ProjectToken are required")
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 50
	}
	if cfg.BatchSize > 500 {
		cfg.BatchSize = 500
	}
	if cfg.FlushInterval <= 0 {
		cfg.FlushInterval = 3 * time.Second
	}
	if cfg.MaxCacheSize <= 0 {
		cfg.MaxCacheSize = 10000
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Second
	}
	if cfg.MaxRetries < 0 {
		cfg.MaxRetries = 3
	}

	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: cfg.Timeout}
	}

	c := &BatchConsumer{
		cfg:      cfg,
		endpoint: resolveBatchEndpoint(cfg.ServerURL),
		client:   client,
		buffer:   make([]TrackEvent, 0, cfg.BatchSize),
		flushCh:  make(chan struct{}, 1),
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
	go c.loop()
	return c, nil
}

func resolveBatchEndpoint(rawURL string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(rawURL), "/")
	if strings.HasSuffix(trimmed, "/collect/api/v1/track/batch") {
		return trimmed
	}
	return trimmed + "/collect/api/v1/track/batch"
}

// Add appends a validated event to the in-memory batch buffer.
func (c *BatchConsumer) Add(event TrackEvent) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return fmt.Errorf("batch consumer is closed")
	}
	if len(c.buffer) >= c.cfg.MaxCacheSize {
		c.mu.Unlock()
		return fmt.Errorf("batch consumer buffer full (max=%d)", c.cfg.MaxCacheSize)
	}
	c.buffer = append(c.buffer, event)
	shouldTrigger := len(c.buffer) >= c.cfg.BatchSize
	c.mu.Unlock()

	if shouldTrigger {
		select {
		case c.flushCh <- struct{}{}:
		default:
		}
	}
	return nil
}

// Flush synchronously sends all currently buffered events to the Gateway.
func (c *BatchConsumer) Flush() error {
	for {
		c.mu.Lock()
		if len(c.buffer) == 0 {
			c.mu.Unlock()
			return nil
		}
		n := c.cfg.BatchSize
		if len(c.buffer) < n {
			n = len(c.buffer)
		}
		batch := make([]TrackEvent, n)
		copy(batch, c.buffer[:n])
		c.buffer = c.buffer[n:]
		c.mu.Unlock()

		if err := c.sendBatchWithRetry(batch); err != nil {
			if c.cfg.OnError != nil {
				c.cfg.OnError(err, batch)
			}
			return err
		}
	}
}

// Close stops the background worker and flushes all remaining buffered events.
func (c *BatchConsumer) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	close(c.stopCh)
	c.mu.Unlock()

	<-c.doneCh
	return c.Flush()
}

func (c *BatchConsumer) loop() {
	ticker := time.NewTicker(c.cfg.FlushInterval)
	defer func() {
		ticker.Stop()
		close(c.doneCh)
	}()

	for {
		select {
		case <-ticker.C:
			_ = c.Flush()
		case <-c.flushCh:
			_ = c.Flush()
		case <-c.stopCh:
			return
		}
	}
}

func (c *BatchConsumer) sendBatchWithRetry(batch []TrackEvent) error {
	payload := TrackBatchPayload{
		ProjectID:    c.cfg.ProjectID,
		ProjectToken: c.cfg.ProjectToken,
		Events:       batch,
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal batch payload: %w", err)
	}
	if c.cfg.CompressGzip {
		var compressed bytes.Buffer
		gz := gzip.NewWriter(&compressed)
		if _, err := gz.Write(bodyBytes); err != nil {
			_ = gz.Close()
			return fmt.Errorf("gzip batch payload: %w", err)
		}
		if err := gz.Close(); err != nil {
			return fmt.Errorf("close gzip writer: %w", err)
		}
		bodyBytes = compressed.Bytes()
	}

	maxAttempts := c.cfg.MaxRetries + 1
	if maxAttempts < 1 {
		maxAttempts = 1
	}

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(50*(1<<(attempt-1))) * time.Millisecond
			if backoff > 2*time.Second {
				backoff = 2 * time.Second
			}
			time.Sleep(backoff)
		}

		req, err := http.NewRequest(http.MethodPost, c.endpoint, bytes.NewReader(bodyBytes))
		if err != nil {
			return fmt.Errorf("create request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		if c.cfg.CompressGzip {
			req.Header.Set("Content-Encoding", "gzip")
		}
		req.Header.Set("User-Agent", SDKVersion)

		resp, err := c.client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("send batch request: %w", err)
			continue
		}
		respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			return nil
		}
		// Retry on 429 Too Many Requests or 5xx Server Errors (preserving event_id for StarRocks deduplication)
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("gateway retryable status %d: %s", resp.StatusCode, string(respBytes))
			continue
		}
		// Non-retryable 4xx error
		return fmt.Errorf("gateway rejected batch (status=%d): %s", resp.StatusCode, string(respBytes))
	}
	return lastErr
}
