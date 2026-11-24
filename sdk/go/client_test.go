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
	"time"
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

func TestTypedGatewayRequestsMarshalExtraFields(t *testing.T) {
	client, requests, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}, Options{APIKey: "sk-test"})

	_, err := client.Gateway.Chat.Completions.Create(context.Background(), ChatCompletionRequest{
		Messages: []ChatMessage{{Role: "user", Content: "hi"}},
		Extra:    map[string]any{"tools": []any{map[string]any{"type": "function"}}},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte((*requests)[0].Body), &payload); err != nil {
		t.Fatalf("request body is invalid JSON: %v", err)
	}
	if payload["tools"] == nil || payload["messages"] == nil {
		t.Fatalf("typed and extra fields were not both encoded: %#v", payload)
	}
}

func TestGatewayChatSendsAuthAndJSON(t *testing.T) {
	client, requests, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-CrewRouter-Request-Id", "req-123")
		w.Header().Set("X-CrewRouter-Signature", "signed")
		_, _ = w.Write([]byte(`{"id":"chatcmpl-1","choices":[]}`))
	}, Options{APIKey: "sk-test"})

	response, err := client.Gateway.Chat.Completions.Create(context.Background(), ChatCompletionRequest{
		Model:    "claude-fable-5",
		Messages: []ChatMessage{{Role: "user", Content: "hi"}},
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

	stream, err := client.Gateway.Chat.Completions.Stream(context.Background(), ChatCompletionRequest{Messages: []ChatMessage{}})
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

func TestStreamIdleTimeoutIsTerminalAndClosesBody(t *testing.T) {
	closed := make(chan struct{})
	client, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-r.Context().Done()
		close(closed)
	}, Options{APIKey: "sk-test", StreamIdleTimeout: 25 * time.Millisecond})

	stream, err := client.Stream(context.Background(), http.MethodPost, "/stream", map[string]any{}, StreamOptions{})
	if err != nil {
		t.Fatalf("Stream() error = %v", err)
	}
	_, err = stream.Next()
	var timeoutErr *TimeoutError
	if !errors.As(err, &timeoutErr) {
		t.Fatalf("Next() error = %T (%v), want *TimeoutError", err, err)
	}
	if _, err := stream.Next(); err != io.EOF {
		t.Fatalf("Next() after timeout error = %v, want io.EOF", err)
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("stream request context remained active after timeout")
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

	_, err := client.Gateway.Chat.Completions.Create(context.Background(), ChatCompletionRequest{Messages: []ChatMessage{}})
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

func TestRedirectPolicy(t *testing.T) {
	for _, operation := range []string{"Request", "Stream"} {
		for _, scenario := range []struct {
			name        string
			tls         bool
			crossOrigin bool
		}{
			{name: "same-origin"},
			{name: "same-origin-tls", tls: true},
			{name: "cross-origin-port", crossOrigin: true},
			{name: "https-downgrade", tls: true, crossOrigin: true},
		} {
			for _, policy := range []string{"default", "custom-nil", "custom-allow", "custom-deny"} {
				t.Run(operation+"/"+scenario.name+"/"+policy, func(t *testing.T) {
					var sourceCalls, targetCalls, redirectCalls atomic.Int32
					var sourceKey, targetKey atomic.Value
					targetHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						targetCalls.Add(1)
						targetKey.Store(r.Header.Get("X-API-Key"))
						if r.Method != http.MethodPost {
							t.Errorf("redirect method = %q, want POST", r.Method)
						}
						body, err := io.ReadAll(r.Body)
						if err != nil || string(body) != `{"message":"test"}` {
							t.Errorf("redirect body = %q, error = %v", body, err)
						}
						w.Header().Set("Content-Type", "text/event-stream")
						_, _ = io.WriteString(w, "data: [DONE]\n\n")
					})
					var targetURL string
					if scenario.crossOrigin {
						target := httptest.NewServer(targetHandler)
						defer target.Close()
						targetURL = target.URL + "/final"
					}
					sourceHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path == "/final" {
							targetHandler.ServeHTTP(w, r)
							return
						}
						sourceCalls.Add(1)
						sourceKey.Store(r.Header.Get("X-API-Key"))
						location := targetURL
						if location == "" {
							location = "/final"
						}
						http.Redirect(w, r, location, http.StatusTemporaryRedirect)
					})
					var source *httptest.Server
					if scenario.tls {
						source = httptest.NewTLSServer(sourceHandler)
					} else {
						source = httptest.NewServer(sourceHandler)
					}
					defer source.Close()

					options := Options{BaseURL: source.URL, APIKey: "sk-redirect-test", AuthStyle: "x-api-key"}
					customErr := errors.New("custom redirect denied")
					if policy != "default" {
						options.HTTPClient = source.Client()
						if policy != "custom-nil" {
							options.HTTPClient.CheckRedirect = func(req *http.Request, via []*http.Request) error {
								redirectCalls.Add(1)
								if policy == "custom-deny" {
									return customErr
								}
								return nil
							}
						}
					}
					client, err := New(options)
					if err != nil {
						t.Fatal(err)
					}
					if options.HTTPClient != nil && client.HTTPClient != options.HTTPClient {
						t.Fatal("custom HTTPClient was replaced")
					}
					if policy == "default" && scenario.tls {
						// Trust only the local test server without replacing the SDK policy.
						client.HTTPClient.Transport = source.Client().Transport
					}
					err = exerciseRedirect(t, client, operation)
					blocked := policy == "custom-deny" || (policy == "default" && scenario.crossOrigin)
					if blocked {
						var connectionErr *ConnectionError
						if !errors.As(err, &connectionErr) {
							t.Fatalf("error = %v, want *ConnectionError", err)
						}
						if policy == "custom-deny" && !errors.Is(err, customErr) {
							t.Fatalf("error = %v, want custom redirect error", err)
						}
						if policy == "default" && !strings.Contains(err.Error(), "cross-origin redirect blocked") {
							t.Fatalf("unexpected redirect error = %v", err)
						}
					} else if err != nil {
						t.Fatalf("redirect error = %v", err)
					}
					if sourceCalls.Load() != 1 || sourceKey.Load() != "sk-redirect-test" {
						t.Fatalf("source calls = %d, key = %v", sourceCalls.Load(), sourceKey.Load())
					}
					wantTargets := int32(1)
					if blocked {
						wantTargets = 0
					}
					if targetCalls.Load() != wantTargets {
						t.Fatalf("target calls = %d, want %d", targetCalls.Load(), wantTargets)
					}
					if !blocked && targetKey.Load() != "sk-redirect-test" {
						t.Fatalf("target key = %v", targetKey.Load())
					}
					wantCallbacks := int32(0)
					if policy == "custom-allow" || policy == "custom-deny" {
						wantCallbacks = 1
					}
					if redirectCalls.Load() != wantCallbacks {
						t.Fatalf("custom callback calls = %d, want %d", redirectCalls.Load(), wantCallbacks)
					}
				})
			}
		}
	}
}

func exerciseRedirect(t *testing.T, client *Client, operation string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	body := map[string]any{"message": "test"}
	if operation == "Stream" {
		stream, err := client.Stream(ctx, http.MethodPost, "/start", body, StreamOptions{})
		if err != nil {
			return err
		}
		defer stream.Close()
		event, err := stream.Next()
		if err != nil || !event.Done {
			t.Fatalf("stream event = %#v, error = %v", event, err)
		}
		return nil
	}
	response, err := client.Request(ctx, http.MethodPost, "/start", RequestOptions{Body: body})
	if err == nil && (response.Status != http.StatusOK || response.Text() != "data: [DONE]\n\n") {
		t.Fatalf("response = %#v", response)
	}
	return err
}

func TestDefaultRedirectLimit(t *testing.T) {
	for _, operation := range []string{"Request", "Stream"} {
		t.Run(operation, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				http.Redirect(w, r, "/start", http.StatusTemporaryRedirect)
			}))
			defer server.Close()
			client, err := New(Options{BaseURL: server.URL, APIKey: "sk-redirect-test", AuthStyle: "x-api-key"})
			if err != nil {
				t.Fatal(err)
			}
			err = exerciseRedirect(t, client, operation)
			if err == nil || !strings.Contains(err.Error(), "stopped after 10 redirects") {
				t.Fatalf("error = %v, want redirect limit error", err)
			}
			if calls.Load() != 10 {
				t.Fatalf("requests = %d, want 10", calls.Load())
			}
		})
	}
}
