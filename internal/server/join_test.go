package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestServerAdmissionSurvivesOfflineHostAndRestart(t *testing.T) {
	s := testServer(t)
	salt := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 16))
	credential := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))
	wrapped := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 60))
	call := func(path string, body map[string]any, access bool) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
		if access {
			r.Header.Set("Authorization", "Bearer server-access")
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	created := call("/api/v1/rooms", map[string]any{"name": "Room", "nickname": "Host", "deviceId": strings.Repeat("h", 24), "maxParticipants": 3, "hostDisconnectTimeoutMinutes": 30, "joinSalt": salt, "joinCredential": credential, "wrappedRoomKey": wrapped}, true)
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	var grant struct {
		Room        struct{ ID string }
		MemberID    string
		ResumeToken string
	}
	if err := json.Unmarshal(created.Body.Bytes(), &grant); err != nil {
		t.Fatal(err)
	}
	roomID := grant.Room.ID
	// The host has never connected to either websocket or LiveKit.
	if s.members[grant.MemberID].Connected {
		t.Fatal("host should be offline")
	}
	// Reload durable state, as on a process restart. No host-held key is required.
	rooms, members, err := s.store.load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s.rooms, s.members = rooms, members
	join := map[string]any{"nickname": "Guest", "deviceId": strings.Repeat("g", 24), "joinCredential": credential}
	if w := call("/api/v1/rooms/"+roomID+"/join", join, false); w.Code != 401 {
		t.Fatalf("missing access: %d", w.Code)
	}
	join["joinCredential"] = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{4}, 32))
	if w := call("/api/v1/rooms/"+roomID+"/join", join, true); w.Code != 403 || strings.Contains(w.Body.String(), wrapped) {
		t.Fatalf("wrong code: %d %s", w.Code, w.Body)
	}
	if s.memberCount(roomID) != 1 {
		t.Fatal("wrong code allocated member")
	}
	join["joinCredential"] = credential
	joined := call("/api/v1/rooms/"+roomID+"/join", join, true)
	if joined.Code != 201 {
		t.Fatalf("offline host join: %d %s", joined.Code, joined.Body)
	}
	var response map[string]any
	_ = json.Unmarshal(joined.Body.Bytes(), &response)
	if response["wrappedRoomKey"] != wrapped || response["livekitToken"] == "" {
		t.Fatal("missing encrypted key or media grant")
	}
	if s.memberCount(roomID) != 2 {
		t.Fatal("guest not saved")
	}
	for _, member := range s.members {
		if member.ID != grant.MemberID && member.ReconnectDeadline.IsZero() {
			t.Fatal("missing reconnect retention")
		}
	}
	summary, _ := json.Marshal(s.roomJSON(s.rooms[roomID]))
	if strings.Contains(string(summary), credential) || strings.Contains(string(summary), wrapped) {
		t.Fatal("room list leaks credentials")
	}
	var stored []byte
	if err := s.store.db.QueryRow(`SELECT credential_hash FROM room_join_credentials WHERE room_id=?`, roomID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(stored, []byte(credential)) || !bytes.Equal(stored, tokenHash(credential)) {
		t.Fatal("credential not hashed")
	}
	// Room capacity includes offline reserved identities.
	if w := call("/api/v1/rooms/"+roomID+"/join", join, true); w.Code != 201 {
		t.Fatalf("second join: %d", w.Code)
	}
	if w := call("/api/v1/rooms/"+roomID+"/join", join, true); w.Code != 409 {
		t.Fatalf("full room: %d", w.Code)
	}
}

func TestServerAdmissionRateLimitsBeforeAllocatingMembers(t *testing.T) {
	s := testServer(t)
	// Even nonexistent rooms are rate-limited without allocating any state.
	body := `{"nickname":"Guest","deviceId":"123456789012345678901234","joinCredential":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}`
	for i := 0; i < 11; i++ {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/rooms/missing/join", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer server-access")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		want := 404
		if i == 10 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("attempt %d = %d, want %d", i, w.Code, want)
		}
	}
	if len(s.members) != 0 {
		t.Fatal("failed joins allocate members")
	}
}
