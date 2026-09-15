package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

type eventStream chan []byte

func (s *Server) eventPrincipal(token string) (*Member, *Admission) {
	hash := tokenHash(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, member := range s.members {
		if subtle.ConstantTimeCompare(member.ResumeTokenHash, hash) == 1 {
			return member, nil
		}
	}
	for _, admission := range s.admissions {
		if subtle.ConstantTimeCompare(admission.ResumeTokenHash, hash) == 1 {
			return nil, admission
		}
	}
	return nil, nil
}

// eventHTTPStream is a fetch-stream fallback for deployments whose reverse
// proxy cannot upgrade WebSockets. Each line is one JSON management event.
func (s *Server) eventHTTPStream(w http.ResponseWriter, r *http.Request) {
	member, admission := s.eventPrincipal(eventSessionToken(r))
	if member == nil && admission == nil {
		writeError(w, http.StatusUnauthorized, "会话无效")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "服务器不支持流式响应")
		return
	}
	streamID := memberID(member, admission)
	stream := make(eventStream, 64)
	s.addEventStream(streamID, stream)
	defer func() {
		s.removeEventStream(streamID, stream)
		if member != nil && !s.hasSocket(streamID) {
			s.markConnected(member.ID, false)
		}
	}()
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("\n"))
	flusher.Flush()
	if member != nil {
		s.markConnected(member.ID, true)
	}

	ctx := r.Context()
	if admission != nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 35*time.Second)
		defer cancel()
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case payload := <-stream:
			if _, err := w.Write(payload); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := w.Write([]byte("\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) eventHTTPSend(w http.ResponseWriter, r *http.Request) {
	member, admission := s.eventPrincipal(eventSessionToken(r))
	if member == nil && admission == nil {
		writeError(w, http.StatusUnauthorized, "会话无效")
		return
	}
	var event map[string]any
	if !decodeJSON(w, r, &event) {
		return
	}
	if err := s.routeEvent(r.Context(), member, admission, event); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) addEventStream(id string, stream eventStream) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.eventStreams[id] == nil {
		s.eventStreams[id] = map[eventStream]struct{}{}
	}
	s.eventStreams[id][stream] = struct{}{}
}

func (s *Server) removeEventStream(id string, stream eventStream) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.eventStreams[id], stream)
	if len(s.eventStreams[id]) == 0 {
		delete(s.eventStreams, id)
	}
}

func encodeStreamEvent(value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return append(payload, '\n'), nil
}

func deliverStreamEvent(stream eventStream, payload []byte) error {
	select {
	case stream <- payload:
		return nil
	case <-time.After(2 * time.Second):
		return errors.New("event stream is not consuming messages")
	}
}
