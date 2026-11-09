package crewrouter

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type recordedRequest struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Body   string
}

func testClient(t *testing.T, handler http.HandlerFunc, options Options) (*Client, *[]recordedRequest, *httptest.Server) {
	t.Helper()
	requests := &[]recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		*requests = append(*requests, recordedRequest{
			Method: r.Method,
			Path:   r.URL.Path,
			Query:  r.URL.RawQuery,
			Header: r.Header.Clone(),
			Body:   string(body),
		})
		handler(w, r)
	}))
	t.Cleanup(server.Close)

	options.BaseURL = server.URL
	client, err := New(options)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return client, requests, server
}

func TestGatewayChatSendsAuthAndJSON(t *testing.T) {
	client, requests, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-CrewRouter-Request-Id", "req-123")
		w.Header().Set("X-CrewRouter-Signature", "signed")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1","choices":[]}`))
	}, Options{APIKey: "sk-test"})

	response, err := client.Gateway.Chat.Completions.Create(context.Background(), map[string]any{
		"model":    "claude-fable-5",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	var payload map[string]any
	if err := response.JSON(&payload); err != nil {
		t.Fatalf("JSON() error = %v", err)
	}
	if payload["id"] != "chatcmpl-1" {
		t.Fatalf("payload = %#v", payload)
	}
	if response.RequestID != "req-123" || response.Signature != "signed" {
		t.Fatalf("metadata = %#v", response)
	}

	recorded := (*requests)[0]
	if recorded.Method != http.MethodPost || recorded.Path != "/v1/chat/completions" {
		t.Fatalf("request = %#v", recorded)
	}
	if recorded.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("authorization = %q", recorded.Header.Get("Authorization"))
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(recorded.Body), &body); err != nil {
		t.Fatalf("body JSON error = %v", err)
	}
	if body["model"] != "claude-fable-5" {
		t.Fatalf("body = %#v", body)
	}
}

func TestXAPIKeyAuthStyle(t *testing.T) {
	client, requests, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[]}`))
	}, Options{APIKey: "sk-test", AuthStyle: "x-api-key"})

	if _, err := client.Gateway.Models.List(context.Background()); err != nil {
		t.Fatalf("List() error = %v", err)
	}
	recorded := (*requests)[0]
	if recorded.Header.Get("x-api-key") != "sk-test" {
		t.Fatalf("x-api-key = %q", recorded.Header.Get("x-api-key"))
	}
	if recorded.Header.Get("Authorization") != "" {
		t.Fatalf("authorization should be empty, got %q", recorded.Header.Get("Authorization"))
	}
}

func TestCallSubstitutesPathAndQuery(t *testing.T) {
	client, requests, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}, Options{APIKey: "sk-test"})

	_, err := client.Call(context.Background(), "user.apiKeys.byId.models.list", CallOptions{
		PathParams: map[string]any{"id": 42},
		Query:      map[string]any{"days": 7, "tag": []string{"a", "b"}, "skip": nil},
	})
	if err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	recorded := (*requests)[0]
	if recorded.Path != "/api/user/api-keys/42/models" {
		t.Fatalf("path = %q", recorded.Path)
	}
	if recorded.Query != "days=7&tag=a&tag=b" {
		t.Fatalf("query = %q", recorded.Query)
	}
}

func TestManagementErrorExposesCodeAndPermission(t *testing.T) {
	client, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"API Key 没有该权限: keys.read","code":"permission_denied","permission":"keys.read"}`))
	}, Options{APIKey: "sk-test"})

	_, err := client.Keys.List(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type = %T, want *APIError", err)
	}
	if apiErr.Status != http.StatusForbidden || apiErr.Code != "permission_denied" || apiErr.Permission != "keys.read" {
		t.Fatalf("apiErr = %#v", apiErr)
	}
	if apiErr.Protocol != "management" {
		t.Fatalf("protocol = %q", apiErr.Protocol)
	}
}

func TestStreamParsesEventsAndDone(t *testing.T) {
	client, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = w.Write([]byte(": keep-alive\n\n"))
		_, _ = w.Write([]byte("event: message_delta\ndata: {\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}, Options{APIKey: "sk-test"})

	stream, err := client.Gateway.Chat.Completions.Stream(context.Background(), map[string]any{"messages": []any{}})
	if err != nil {
		t.Fatalf("Stream() error = %v", err)
	}
	defer stream.Close()

	var events []StreamEvent
	for {
		event, err := stream.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Next() error = %v", err)
		}
		events = append(events, event)
	}
	if len(events) != 3 {
		t.Fatalf("events = %d, want 3", len(events))
	}
	if string(events[0].Parsed) != `{"choices":[{"delta":{"content":"你好"}}]}` {
		t.Fatalf("first event = %#v", events[0])
	}
	if events[1].Event != "message_delta" {
		t.Fatalf("second event = %#v", events[1])
	}
	if !events[2].Done || events[2].Data != "[DONE]" {
		t.Fatalf("done event = %#v", events[2])
	}
}

func TestGetRetries429AndPostDoesNotByDefault(t *testing.T) {
	var getAttempts atomic.Int32
	var postAttempts atomic.Int32
	client, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusTooManyRequests)
		if r.Method == http.MethodGet {
			getAttempts.Add(1)
		} else {
			postAttempts.Add(1)
		}
		_, _ = w.Write([]byte(`{"error":"slow down"}`))
	}, Options{APIKey: "sk-test", MaxRetries: 2})

	_, err := client.Gateway.Chat.Completions.Create(context.Background(), map[string]any{"messages": []any{}})
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTooManyRequests {
		t.Fatalf("POST error = %v", err)
	}
	if postAttempts.Load() != 1 {
		t.Fatalf("POST attempts = %d, want 1", postAttempts.Load())
	}

	_, err = client.Gateway.Models.List(context.Background())
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTooManyRequests {
		t.Fatalf("GET error = %v", err)
	}
	if getAttempts.Load() != 3 {
		t.Fatalf("GET attempts = %d, want 3", getAttempts.Load())
	}
}

func TestSessionOnlyOperationRejectedBeforeRequest(t *testing.T) {
	client, requests, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("request should not be sent")
	}, Options{APIKey: "sk-test"})

	_, err := client.Call(context.Background(), "2fa.status.list", CallOptions{})
	if err == nil || !strings.Contains(err.Error(), "session-only") {
		t.Fatalf("error = %v", err)
	}
	if len(*requests) != 0 {
		t.Fatalf("requests = %d, want 0", len(*requests))
	}
}
