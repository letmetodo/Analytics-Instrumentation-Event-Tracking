package abi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DebugConfig configures DebugConsumer for synchronous development-time event validation.
type DebugConfig struct {
	ServerURL    string
	ProjectID    int64
	ProjectToken string
	DryRun       bool
	Timeout      time.Duration
	HTTPClient   *http.Client
}

// DebugConsumer sends each event synchronously with debug=true (and optional dry_run=true)
// and immediately returns any L3/L4 validation error reported by ABI Gateway.
type DebugConsumer struct {
	cfg      DebugConfig
	endpoint string
	client   *http.Client
}

// NewDebugConsumer creates a new DebugConsumer.
func NewDebugConsumer(cfg DebugConfig) (*DebugConsumer, error) {
	if strings.TrimSpace(cfg.ServerURL) == "" {
		return nil, fmt.Errorf("ServerURL is required")
	}
	if cfg.ProjectID <= 0 || strings.TrimSpace(cfg.ProjectToken) == "" {
		return nil, fmt.Errorf("ProjectID and ProjectToken are required")
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Second
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: cfg.Timeout}
	}
	return &DebugConsumer{
		cfg:      cfg,
		endpoint: resolveBatchEndpoint(cfg.ServerURL),
		client:   client,
	}, nil
}

// Add synchronously sends a single event in debug mode and returns an error if rejected.
func (d *DebugConsumer) Add(event TrackEvent) error {
	payload := TrackBatchPayload{
		ProjectID:    d.cfg.ProjectID,
		ProjectToken: d.cfg.ProjectToken,
		Debug:        true,
		DryRun:       d.cfg.DryRun,
		Events:       []TrackEvent{event},
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal debug payload: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, d.endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("create debug request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", SDKVersion)

	resp, err := d.client.Do(req)
	if err != nil {
		return fmt.Errorf("send debug request: %w", err)
	}
	respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()

	var env GatewayEnvelope
	if err := json.Unmarshal(respBytes, &env); err != nil {
		return fmt.Errorf("gateway status=%d body=%s", resp.StatusCode, string(respBytes))
	}
	if resp.StatusCode != http.StatusOK || env.Code != 200 {
		return fmt.Errorf("gateway error (code=%d): %s", env.Code, env.Message)
	}
	if env.Data.Rejected > 0 || len(env.Data.Errors) > 0 {
		if len(env.Data.Errors) > 0 {
			return fmt.Errorf("debug validation failed for event %q: %s", event.EventName, env.Data.Errors[0].Reason)
		}
		return fmt.Errorf("debug validation rejected event %q", event.EventName)
	}
	return nil
}

// Flush is a no-op for DebugConsumer because events are sent synchronously.
func (d *DebugConsumer) Flush() error {
	return nil
}

// Close is a no-op for DebugConsumer.
func (d *DebugConsumer) Close() error {
	return nil
}
