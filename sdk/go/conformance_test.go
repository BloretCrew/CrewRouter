package crewrouter

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sync/atomic"
	"testing"
)

type transportCase struct {
	Name      string         `json:"name"`
	AuthStyle string         `json:"authStyle"`
	Method    string         `json:"method"`
	Path      string         `json:"path"`
	Query     map[string]any `json:"query"`
	Body      map[string]any `json:"body"`
	Response  struct {
		Status  int               `json:"status"`
		JSON    map[string]any    `json:"json"`
		Headers map[string]string `json:"headers"`
	} `json:"response"`
	Expect struct {
		Path          string         `json:"path"`
		Query         string         `json:"query"`
		Authorization string         `json:"authorization"`
		XAPIKey       string         `json:"xApiKey"`
		ContentType   string         `json:"contentType"`
		Body          map[string]any `json:"body"`
		RequestID     string         `json:"requestId"`
		Signature     string         `json:"signature"`
	} `json:"expect"`
}

type errorCase struct {
	Name    string            `json:"name"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    any               `json:"body"`
	Expect  struct {
		Status     int    `json:"status"`
		Code       string `json:"code"`
		Type       string `json:"type"`
		Permission string `json:"permission"`
		Message    string `json:"message"`
		Protocol   string `json:"protocol"`
		RequestID  string `json:"requestId"`
	} `json:"expect"`
}

type sseCase struct {
	Path   string           `json:"path"`
	Chunks []string         `json:"chunks"`
	Expect []sseEventExpect `json:"expect"`
}

type retryCase struct {
	Name       string         `json:"name"`
	Method     string         `json:"method"`
	Path       string         `json:"path"`
	Body       map[string]any `json:"body"`
	MaxRetries int            `json:"maxRetries"`
	Responses  []struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		JSON    map[string]any    `json:"json"`
	} `json:"responses"`
	Expect struct {
		Status      int `json:"status"`
		ErrorStatus int `json:"errorStatus"`
		Attempts    int `json:"attempts"`
	} `json:"expect"`
}

type conformanceCases struct {
	Transport []transportCase `json:"transport"`
	Errors    []errorCase     `json:"errors"`
	SSE       sseCase         `json:"sse"`
	Retry     []retryCase     `json:"retry"`
}

func loadCases(t *testing.T) conformanceCases {
	t.Helper()
	raw, err := os.ReadFile("../contract/conformance/cases.json")
	if err != nil {
		t.Fatalf("read conformance cases: %v", err)
	}
	var cases conformanceCases
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parse conformance cases: %v", err)
	}
	return cases
}

func newFixtureServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func writeJSON(w http.ResponseWriter, status int, payload any, headers map[string]string) {
	for key, value := range headers {
		w.Header().Set(key, value)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func TestConformanceTransport(t *testing.T) {
	cases := loadCases(t)
	for _, fixture := range cases.Transport {
		t.Run(fixture.Name, func(t *testing.T) {
			var recorded struct {
				method string
				path   string
				query  string
				header http.Header
				body   map[string]any
			}
			server := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
				recorded.method = r.Method
				recorded.path = r.URL.Path
				recorded.query = r.URL.RawQuery
				recorded.header = r.Header.Clone()
				if r.Body != nil {
					_ = json.NewDecoder(r.Body).Decode(&recorded.body)
				}
				writeJSON(w, fixture.Response.Status, fixture.Response.JSON, fixture.Response.Headers)
			})

			client, err := New(Options{BaseURL: server.URL, APIKey: "sk-test", AuthStyle: fixture.AuthStyle})
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			response, err := client.Request(context.Background(), fixture.Method, fixture.Path, RequestOptions{
				Query: fixture.Query,
				Body:  fixture.Body,
			})
			if err != nil {
				t.Fatalf("Request() error = %v", err)
			}

			if recorded.method != fixture.Method || recorded.path != fixture.Expect.Path {
				t.Fatalf("request = %s %s", recorded.method, recorded.path)
			}
			if recorded.query != fixture.Expect.Query {
				t.Fatalf("query = %q, want %q", recorded.query, fixture.Expect.Query)
			}
			if fixture.Expect.Authorization != "" && recorded.header.Get("Authorization") != fixture.Expect.Authorization {
				t.Fatalf("authorization = %q", recorded.header.Get("Authorization"))
			}
			if fixture.Expect.XAPIKey != "" {
				if recorded.header.Get("x-api-key") != fixture.Expect.XAPIKey {
					t.Fatalf("x-api-key = %q", recorded.header.Get("x-api-key"))
				}
				if recorded.header.Get("Authorization") != "" {
					t.Fatalf("authorization should be empty")
				}
			}
			if fixture.Expect.ContentType != "" && recorded.header.Get("Content-Type") != fixture.Expect.ContentType {
				t.Fatalf("content-type = %q", recorded.header.Get("Content-Type"))
			}
			if fixture.Expect.Body != nil && !reflect.DeepEqual(recorded.body, fixture.Expect.Body) {
				t.Fatalf("body = %#v, want %#v", recorded.body, fixture.Expect.Body)
			}
			if fixture.Response.JSON != nil {
				var data map[string]any
				if err := response.JSON(&data); err != nil {
					t.Fatalf("response.JSON() error = %v", err)
				}
				if !reflect.DeepEqual(data, fixture.Response.JSON) {
					t.Fatalf("response = %#v", data)
				}
			}
			if fixture.Expect.RequestID != "" && response.RequestID != fixture.Expect.RequestID {
				t.Fatalf("request id = %q", response.RequestID)
			}
			if fixture.Expect.Signature != "" && response.Signature != fixture.Expect.Signature {
				t.Fatalf("signature = %q", response.Signature)
			}
		})
	}
}

func TestConformanceErrors(t *testing.T) {
	cases := loadCases(t)
	for _, fixture := range cases.Errors {
		t.Run(fixture.Name, func(t *testing.T) {
			server := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, fixture.Status, fixture.Body, fixture.Headers)
			})
			client, err := New(Options{BaseURL: server.URL, APIKey: "sk-test"})
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			_, err = client.Request(context.Background(), "GET", "/fixture", RequestOptions{})
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("error type = %T, want *APIError", err)
			}
			if apiErr.Status != fixture.Expect.Status {
				t.Fatalf("status = %d", apiErr.Status)
			}
			if fixture.Expect.Code != "" && apiErr.Code != fixture.Expect.Code {
				t.Fatalf("code = %q", apiErr.Code)
			}
			if fixture.Expect.Type != "" && apiErr.Type != fixture.Expect.Type {
				t.Fatalf("type = %q", apiErr.Type)
			}
			if fixture.Expect.Permission != "" && apiErr.Permission != fixture.Expect.Permission {
				t.Fatalf("permission = %q", apiErr.Permission)
			}
			if fixture.Expect.Message != "" && apiErr.Message != fixture.Expect.Message {
				t.Fatalf("message = %q", apiErr.Message)
			}
			if fixture.Expect.Protocol != "" && apiErr.Protocol != fixture.Expect.Protocol {
				t.Fatalf("protocol = %q", apiErr.Protocol)
			}
			if fixture.Expect.RequestID != "" && apiErr.RequestID != fixture.Expect.RequestID {
				t.Fatalf("request id = %q", apiErr.RequestID)
			}
		})
	}
}

func TestConformanceSSE(t *testing.T) {
	cases := loadCases(t)
	server := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for _, chunk := range cases.SSE.Chunks {
			_, _ = io.WriteString(w, chunk)
			if flusher != nil {
				flusher.Flush()
			}
		}
	})

	client, err := New(Options{BaseURL: server.URL, APIKey: "sk-test"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream, err := client.Stream(context.Background(), "POST", cases.SSE.Path, map[string]any{"messages": []any{}}, StreamOptions{})
	if err != nil {
		t.Fatalf("Stream() error = %v", err)
	}
	defer stream.Close()

	var events []sseEventExpect
	for {
		event, err := stream.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("Next() error = %v", err)
		}
		events = append(events, sseEventExpect{Event: event.Event, Data: event.Data, Done: event.Done})
	}
	if !reflect.DeepEqual(events, cases.SSE.Expect) {
		t.Fatalf("events = %#v, want %#v", events, cases.SSE.Expect)
	}
}

type sseEventExpect struct {
	Event string `json:"event"`
	Data  string `json:"data"`
	Done  bool   `json:"done"`
}

func TestConformanceRetry(t *testing.T) {
	cases := loadCases(t)
	for _, fixture := range cases.Retry {
		t.Run(fixture.Name, func(t *testing.T) {
			var attempts atomic.Int32
			server := newFixtureServer(t, func(w http.ResponseWriter, r *http.Request) {
				index := int(attempts.Load())
				if index >= len(fixture.Responses) {
					index = len(fixture.Responses) - 1
				}
				response := fixture.Responses[index]
				attempts.Add(1)
				writeJSON(w, response.Status, response.JSON, response.Headers)
			})

			maxRetries := fixture.MaxRetries
			client, err := New(Options{BaseURL: server.URL, APIKey: "sk-test"})
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			response, err := client.Request(context.Background(), fixture.Method, fixture.Path, RequestOptions{
				Body:       fixture.Body,
				MaxRetries: &maxRetries,
			})
			if fixture.Expect.Status != 0 {
				if err != nil {
					t.Fatalf("Request() error = %v", err)
				}
				if response.Status != fixture.Expect.Status {
					t.Fatalf("status = %d", response.Status)
				}
			} else {
				var apiErr *APIError
				if !errors.As(err, &apiErr) {
					t.Fatalf("error type = %T, want *APIError", err)
				}
				if apiErr.Status != fixture.Expect.ErrorStatus {
					t.Fatalf("error status = %d", apiErr.Status)
				}
			}
			if int(attempts.Load()) != fixture.Expect.Attempts {
				t.Fatalf("attempts = %d, want %d", attempts.Load(), fixture.Expect.Attempts)
			}
		})
	}
}
