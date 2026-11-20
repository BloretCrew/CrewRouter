package crewrouter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var pathParamPattern = regexp.MustCompile(`:([A-Za-z0-9_]+)`)

var retryableStatuses = map[int]bool{
	408: true,
	429: true,
	500: true,
	502: true,
	503: true,
	504: true,
}

const (
	defaultManagementTimeout = 30 * time.Second
	defaultGatewayTimeout    = 600 * time.Second
	defaultStreamIdleTimeout = 120 * time.Second
	defaultUserAgent         = "crewrouter-sdk-go/27.0.0-beta.1"
)

// Response is a parsed CrewRouter response. Data holds the raw body unless
// ResponseType was "stream", in which case Raw.Body is still open.
type Response struct {
	Data            []byte
	Raw             *http.Response
	Status          int
	Headers         http.Header
	RequestID       string
	Signature       string
	SignatureBase64 string
}

// JSON decodes the response body into v.
func (r *Response) JSON(v any) error {
	if len(r.Data) == 0 {
		return nil
	}
	return json.Unmarshal(r.Data, v)
}

// Text returns the response body as a string.
func (r *Response) Text() string { return string(r.Data) }

// RequestOptions controls a raw HTTP request.
type RequestOptions struct {
	Query              map[string]any
	Body               any
	RawBody            io.Reader
	ContentType        string
	Headers            map[string]string
	ResponseType       string // json, text, bytes, stream
	Timeout            time.Duration
	MaxRetries         *int
	RetryNonIdempotent *bool
}

// CallOptions controls an operation call.
type CallOptions struct {
	PathParams         map[string]any
	Query              map[string]any
	Body               any
	RawBody            io.Reader
	ContentType        string
	Headers            map[string]string
	ResponseType       string
	Timeout            time.Duration
	MaxRetries         *int
	RetryNonIdempotent *bool
}

// StreamOptions controls a streaming request.
type StreamOptions struct {
	Headers     map[string]string
	IdleTimeout time.Duration
}

// Restrict default-client redirects to the original origin to protect credentials.
func defaultCheckRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errString("stopped after 10 redirects")
	}
	origin := via[0].URL
	if !strings.EqualFold(req.URL.Scheme, origin.Scheme) || !strings.EqualFold(req.URL.Host, origin.Host) {
		return errString("crewrouter: cross-origin redirect blocked")
	}
	return nil
}

func defaultTimeoutFor(path string) time.Duration {
	if strings.HasPrefix(path, "/v1/") {
		return defaultGatewayTimeout
	}
	return defaultManagementTimeout
}

func methodMayRetry(method string, retryNonIdempotent bool) bool {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete, http.MethodOptions:
		return true
	default:
		return retryNonIdempotent
	}
}

func retryDelay(attempt int, retryAfter time.Duration) time.Duration {
	if retryAfter > 0 {
		return retryAfter
	}
	base := 500 * time.Millisecond * time.Duration(1<<min(attempt, 4))
	jitter := 0.75 + rand.Float64()*0.5
	return time.Duration(float64(base) * jitter)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (c *Client) defaultSleep(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return &AbortError{Err: ctx.Err()}
	}
}

func (c *Client) buildHeaders(extra map[string]string) http.Header {
	headers := http.Header{}
	headers.Set("User-Agent", c.userAgent)
	for key, value := range c.headers {
		headers.Set(key, value)
	}
	for key, value := range extra {
		headers.Set(key, value)
	}
	if c.oauthToken != "" {
		headers.Set("Authorization", "Bearer "+c.oauthToken)
	} else if c.apiKey != "" {
		if c.authStyle == "x-api-key" {
			headers.Set("x-api-key", c.apiKey)
		} else {
			headers.Set("Authorization", "Bearer "+c.apiKey)
		}
	}
	if c.signatureMode != "" {
		headers.Set("x-crewrouter-signature-mode", c.signatureMode)
	}
	return headers
}

func buildQuery(base string, query map[string]any) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	values := parsed.Query()
	for key, value := range query {
		if value == nil {
			continue
		}
		switch typed := value.(type) {
		case []string:
			for _, item := range typed {
				values.Add(key, item)
			}
		case []any:
			for _, item := range typed {
				if item != nil {
					values.Add(key, fmt.Sprint(item))
				}
			}
		default:
			values.Set(key, fmt.Sprint(value))
		}
	}
	parsed.RawQuery = values.Encode()
	return parsed.String(), nil
}

func encodeBody(opts RequestOptions) ([]byte, string, error) {
	if opts.RawBody != nil {
		data, err := io.ReadAll(opts.RawBody)
		if err != nil {
			return nil, "", err
		}
		contentType := opts.ContentType
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		return data, contentType, nil
	}
	if opts.Body == nil {
		return nil, "", nil
	}
	data, err := json.Marshal(opts.Body)
	if err != nil {
		return nil, "", err
	}
	contentType := opts.ContentType
	if contentType == "" {
		contentType = "application/json"
	}
	return data, contentType, nil
}

// Request performs a raw HTTP request with retries.
func (c *Client) Request(ctx context.Context, method, path string, opts RequestOptions) (*Response, error) {
	bodyBytes, contentType, err := encodeBody(opts)
	if err != nil {
		return nil, err
	}

	base := strings.TrimRight(c.BaseURL, "/") + "/" + strings.TrimLeft(path, "/")
	target, err := buildQuery(base, opts.Query)
	if err != nil {
		return nil, err
	}

	timeout := opts.Timeout
	if timeout == 0 {
		timeout = c.Timeout
	}
	if timeout == 0 {
		timeout = defaultTimeoutFor(path)
	}
	var requestCtx context.Context
	if opts.ResponseType == "stream" {
		// The caller owns the body; do not cancel the context on return.
		requestCtx = ctx
	} else {
		var cancel context.CancelFunc
		requestCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	retries := c.MaxRetries
	if opts.MaxRetries != nil {
		retries = *opts.MaxRetries
	}
	if retries < 0 {
		retries = 0
	}
	retryNonIdempotent := c.RetryNonIdempotent
	if opts.RetryNonIdempotent != nil {
		retryNonIdempotent = *opts.RetryNonIdempotent
	}
	canRetry := methodMayRetry(method, retryNonIdempotent)
	responseType := opts.ResponseType
	if responseType == "" {
		responseType = "json"
	}

	for attempt := 0; ; attempt++ {
		var reader io.Reader
		if bodyBytes != nil {
			reader = bytes.NewReader(bodyBytes)
		}
		req, err := http.NewRequestWithContext(requestCtx, method, target, reader)
		if err != nil {
			return nil, err
		}
		req.Header = c.buildHeaders(opts.Headers)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}

		raw, err := c.HTTPClient.Do(req)
		if err != nil {
			if requestCtx.Err() == context.DeadlineExceeded {
				return nil, &TimeoutError{Err: err}
			}
			if requestCtx.Err() == context.Canceled {
				return nil, &AbortError{Err: err}
			}
			if attempt < retries && canRetry {
				if sleepErr := c.sleep(ctx, retryDelay(attempt, 0)); sleepErr != nil {
					return nil, sleepErr
				}
				continue
			}
			return nil, &ConnectionError{Err: err}
		}

		if raw.StatusCode >= 400 {
			body, _ := io.ReadAll(raw.Body)
			raw.Body.Close()
			apiErr := apiErrorFromResponse(raw.StatusCode, raw.Header, body)
			if attempt < retries && canRetry && retryableStatuses[raw.StatusCode] {
				if sleepErr := c.sleep(ctx, retryDelay(attempt, apiErr.RetryAfter)); sleepErr != nil {
					return nil, sleepErr
				}
				continue
			}
			return nil, apiErr
		}

		response := &Response{
			Raw:             raw,
			Status:          raw.StatusCode,
			Headers:         raw.Header,
			RequestID:       requestIDFromHeaders(raw.Header),
			Signature:       signatureFromHeaders(raw.Header),
			SignatureBase64: raw.Header.Get("X-CrewRouter-Signature-B64"),
		}
		if responseType == "stream" {
			return response, nil
		}
		response.Data, err = io.ReadAll(raw.Body)
		raw.Body.Close()
		if err != nil {
			return nil, &ConnectionError{Err: err}
		}
		return response, nil
	}
}

// Call invokes a generated operation by id.
func (c *Client) Call(ctx context.Context, operationID string, opts CallOptions) (*Response, error) {
	operation, ok := c.Operations[operationID]
	if !ok {
		return nil, fmt.Errorf("crewrouter: unknown operation %q", operationID)
	}
	if operation.SDKStatus == "excluded" && operation.Exclusion == "session_only" {
		return nil, &APIError{
			Status:  403,
			Code:    "session_required",
			Message: fmt.Sprintf("operation %q is session-only and cannot be called with an API Key", operationID),
		}
	}
	if operation.SDKStatus == "excluded" && operation.Exclusion == "alias" {
		return nil, fmt.Errorf("crewrouter: operation %q is an alias; use its canonical operation", operationID)
	}

	path, err := substitutePath(operation.Path, opts.PathParams)
	if err != nil {
		return nil, err
	}
	return c.Request(ctx, operation.Method, path, RequestOptions{
		Query:              opts.Query,
		Body:               opts.Body,
		RawBody:            opts.RawBody,
		ContentType:        opts.ContentType,
		Headers:            opts.Headers,
		ResponseType:       opts.ResponseType,
		Timeout:            opts.Timeout,
		MaxRetries:         opts.MaxRetries,
		RetryNonIdempotent: opts.RetryNonIdempotent,
	})
}

func substitutePath(path string, params map[string]any) (string, error) {
	var missing string
	result := pathParamPattern.ReplaceAllStringFunc(path, func(match string) string {
		name := match[1:]
		value, ok := params[name]
		if !ok || value == nil {
			missing = name
			return match
		}
		return url.PathEscape(fmt.Sprint(value))
	})
	if missing != "" {
		return "", fmt.Errorf("crewrouter: missing path parameter %q", missing)
	}
	return result, nil
}

// Stream opens an SSE stream. Always Close the returned Stream.
func (c *Client) Stream(ctx context.Context, method, path string, body any, opts StreamOptions) (*Stream, error) {
	bodyBytes, contentType, err := encodeBody(RequestOptions{Body: body})
	if err != nil {
		return nil, err
	}
	target := strings.TrimRight(c.BaseURL, "/") + "/" + strings.TrimLeft(path, "/")
	var reader io.Reader
	if bodyBytes != nil {
		reader = bytes.NewReader(bodyBytes)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	req.Header = c.buildHeaders(opts.Headers)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}

	raw, err := c.HTTPClient.Do(req)
	if err != nil {
		if ctx.Err() == context.Canceled {
			return nil, &AbortError{Err: err}
		}
		if ctx.Err() == context.DeadlineExceeded {
			return nil, &TimeoutError{Err: err}
		}
		return nil, &ConnectionError{Err: err}
	}
	if raw.StatusCode >= 400 {
		errorBody, _ := io.ReadAll(raw.Body)
		raw.Body.Close()
		return nil, apiErrorFromResponse(raw.StatusCode, raw.Header, errorBody)
	}

	idle := opts.IdleTimeout
	if idle == 0 {
		idle = c.StreamIdleTimeout
	}
	return newStream(ctx, raw.Body, idle, raw.Header), nil
}

func signatureFromHeaders(headers http.Header) string {
	if plain := headers.Get("X-CrewRouter-Signature"); plain != "" {
		return plain
	}
	if encoded := headers.Get("X-CrewRouter-Signature-B64"); encoded != "" {
		if decoded, err := decodeBase64(encoded); err == nil {
			return decoded
		}
	}
	return ""
}
