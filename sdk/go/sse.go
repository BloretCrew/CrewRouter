package crewrouter

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// StreamEvent is one parsed Server-Sent Event.
type StreamEvent struct {
	Event  string          // SSE event: field, empty when absent
	Data   string          // raw data payload (multi-line data joined with \n)
	Parsed json.RawMessage // valid JSON payload, nil otherwise
	Done   bool            // true for the [DONE] sentinel
}

// Stream is an SSE response. Call Next until io.EOF and always Close it.
type Stream struct {
	ctx    context.Context
	body   io.ReadCloser
	reader *bufio.Reader
	idle   time.Duration
	event  string
	data   []string
	header http.Header
	closed bool
}

func newStream(ctx context.Context, body io.ReadCloser, idle time.Duration, header http.Header) *Stream {
	return &Stream{
		ctx:    ctx,
		body:   body,
		reader: bufio.NewReader(body),
		idle:   idle,
		header: header,
	}
}

// Header returns the response headers.
func (s *Stream) Header() http.Header { return s.header }

// Close releases the underlying response body. It is safe to call twice.
func (s *Stream) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	return s.body.Close()
}

// Next returns the next event, or io.EOF when the stream ends.
func (s *Stream) Next() (StreamEvent, error) {
	if s.closed {
		return StreamEvent{}, io.EOF
	}
	for {
		line, err := s.readLine()
		if err != nil && err != io.EOF {
			return StreamEvent{}, err
		}

		line = strings.TrimSuffix(line, "\n")
		line = strings.TrimSuffix(line, "\r")

		if line == "" {
			if len(s.data) > 0 {
				return s.emit(), nil
			}
			s.event = ""
		} else if !strings.HasPrefix(line, ":") {
			field, value, hasValue := strings.Cut(line, ":")
			if hasValue && strings.HasPrefix(value, " ") {
				value = value[1:]
			}
			switch field {
			case "event":
				s.event = value
			case "data":
				s.data = append(s.data, value)
			}
		}

		if err == io.EOF {
			if len(s.data) > 0 {
				return s.emit(), nil
			}
			return StreamEvent{}, io.EOF
		}
	}
}

func (s *Stream) emit() StreamEvent {
	data := strings.Join(s.data, "\n")
	event := StreamEvent{
		Event: s.event,
		Data:  data,
		Done:  data == "[DONE]",
	}
	if json.Valid([]byte(data)) {
		event.Parsed = json.RawMessage(data)
	}
	s.event = ""
	s.data = nil
	return event
}

func (s *Stream) readLine() (string, error) {
	if s.idle <= 0 {
		return s.reader.ReadString('\n')
	}

	type result struct {
		line string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		line, err := s.reader.ReadString('\n')
		ch <- result{line: line, err: err}
	}()

	timer := time.NewTimer(s.idle)
	defer timer.Stop()

	select {
	case item := <-ch:
		return item.line, item.err
	case <-timer.C:
		s.closed = true
		_ = s.body.Close()
		return "", &TimeoutError{Err: fmt.Errorf("stream idle timeout after %s", s.idle)}
	case <-s.ctx.Done():
		s.closed = true
		_ = s.body.Close()
		return "", &AbortError{Err: s.ctx.Err()}
	}
}
