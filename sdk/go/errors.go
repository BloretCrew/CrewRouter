package crewrouter

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// APIError is returned for non-2xx HTTP responses.
type APIError struct {
	Status     int
	Code       string
	Type       string
	Permission string
	RequestID  string
	RetryAfter time.Duration
	RawBody    json.RawMessage
	Headers    http.Header
	Protocol   string
	Message    string
}

func (e *APIError) Error() string {
	if e.Status > 0 {
		return fmt.Sprintf("crewrouter: HTTP %d: %s", e.Status, e.Message)
	}
	return "crewrouter: " + e.Message
}

// ConnectionError wraps network/DNS/TLS failures.
type ConnectionError struct{ Err error }

func (e *ConnectionError) Error() string { return "crewrouter: connection error: " + e.Err.Error() }
func (e *ConnectionError) Unwrap() error { return e.Err }

// TimeoutError indicates a request or stream idle timeout.
type TimeoutError struct{ Err error }

func (e *TimeoutError) Error() string { return "crewrouter: timeout: " + e.Err.Error() }
func (e *TimeoutError) Unwrap() error { return e.Err }

// AbortError indicates the caller's context was canceled.
type AbortError struct{ Err error }

func (e *AbortError) Error() string {
	if e.Err == nil {
		return "crewrouter: request aborted"
	}
	return "crewrouter: request aborted: " + e.Err.Error()
}
func (e *AbortError) Unwrap() error { return e.Err }

// StreamError wraps a protocol-level stream failure.
type StreamError struct{ Err error }

func (e *StreamError) Error() string { return "crewrouter: stream error: " + e.Err.Error() }
func (e *StreamError) Unwrap() error { return e.Err }

func asMap(value any) map[string]any {
	record, _ := value.(map[string]any)
	return record
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}

func requestIDFromHeaders(headers http.Header) string {
	if value := headers.Get("X-CrewRouter-Request-Id"); value != "" {
		return value
	}
	return headers.Get("X-Request-Id")
}

func parseRetryAfter(headers http.Header) time.Duration {
	value := strings.TrimSpace(headers.Get("Retry-After"))
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil {
		if seconds < 0 {
			return 0
		}
		return time.Duration(seconds * float64(time.Second))
	}
	if when, err := http.ParseTime(value); err == nil {
		if delay := time.Until(when); delay > 0 {
			return delay
		}
	}
	return 0
}

type parsedError struct {
	Message    string
	Type       string
	Code       string
	Permission string
	Protocol   string
	Raw        json.RawMessage
}

func parseErrorPayload(status int, body []byte) parsedError {
	result := parsedError{Protocol: "unknown", Raw: json.RawMessage(body)}
	var parsed any
	if len(body) > 0 {
		if err := json.Unmarshal(body, &parsed); err == nil {
			if record := asMap(parsed); record != nil {
				if asString(record["type"]) == "error" {
					if inner := asMap(record["error"]); inner != nil {
						result.Protocol = "anthropic"
						result.Message = firstNonEmpty(asString(inner["message"]), asString(inner["error"]), fmt.Sprintf("HTTP %d", status))
						result.Type = asString(inner["type"])
						result.Code = asString(inner["code"])
						result.Permission = asString(inner["permission"])
						return result
					}
				}
				if inner := asMap(record["error"]); inner != nil {
					result.Protocol = "openai"
					result.Message = firstNonEmpty(asString(inner["message"]), asString(inner["code"]), fmt.Sprintf("HTTP %d", status))
					result.Type = asString(inner["type"])
					result.Code = asString(inner["code"])
					result.Permission = asString(inner["permission"])
					return result
				}
				if text := asString(record["error"]); text != "" {
					result.Protocol = "management"
					result.Message = text
					result.Type = asString(record["type"])
					result.Code = asString(record["code"])
					result.Permission = asString(record["permission"])
					return result
				}
				if text := asString(record["message"]); text != "" {
					result.Protocol = "management"
					result.Message = text
					result.Type = asString(record["type"])
					result.Code = asString(record["code"])
					result.Permission = asString(record["permission"])
					return result
				}
			}
		}
	}
	result.Message = strings.TrimSpace(string(body))
	if result.Message == "" {
		result.Message = fmt.Sprintf("HTTP %d", status)
	}
	return result
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func apiErrorFromResponse(status int, headers http.Header, body []byte) *APIError {
	parsed := parseErrorPayload(status, body)
	return &APIError{
		Status:     status,
		Code:       parsed.Code,
		Type:       parsed.Type,
		Permission: parsed.Permission,
		RequestID:  requestIDFromHeaders(headers),
		RetryAfter: parseRetryAfter(headers),
		RawBody:    parsed.Raw,
		Headers:    headers,
		Protocol:   parsed.Protocol,
		Message:    parsed.Message,
	}
}
