package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TimeLordFang/DawnMeshServer/internal/config"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	server, err := New(config.Config{
		ListenAddress:       ":0",
		DatabasePath:        t.TempDir() + "/test.db",
		InstanceID:          "test-instance",
		InstanceName:        "Test",
		PublicBaseURL:       "https://talk.example.test",
		LiveKitURL:          "http://127.0.0.1:17880",
		LiveKitPublicURL:    "wss://rtc.example.test",
		LiveKitAPIKey:       "test-key",
		LiveKitAPISecret:    "test-secret-that-is-at-least-thirty-two-characters",
		AccessToken:         "server-access",
		AdminToken:          "admin-access-that-is-at-least-thirty-two-characters",
		MaximumParticipants: 50,
		MaximumRooms:        100,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func TestCreateRoomValidationAndLeastPrivilegeToken(t *testing.T) {
	server := testServer(t)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/rooms", strings.NewReader(`{
      "name":"远程小队","nickname":"房主","deviceId":"123456789012345678901234",
      "maxParticipants":25,"hostDisconnectTimeoutMinutes":60}`))
	request.Header.Set("Authorization", "Bearer server-access")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", response.Code, response.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	token := payload["livekitToken"].(string)
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatal("invalid JWT")
	}
	claimsBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(claimsBytes, &claims); err != nil {
		t.Fatal(err)
	}
	video := claims["video"].(map[string]any)
	if video["canPublish"] != false || video["canPublishData"] != true {
		t.Fatalf("unexpected media grant: %#v", video)
	}
}

func TestHostTimeoutTransfersToEarliestOnlineMember(t *testing.T) {
	server := testServer(t)
	now := time.Now().UTC()
	room := &Room{ID: "room", Name: "Room", HostMemberID: "host", HostNickname: "Host", MaxParticipants: 25, HostDisconnectTimeoutMinutes: 1, CreatedAt: now, HostReconnectDeadline: now.Add(-time.Second)}
	host := &Member{ID: "host", RoomID: room.ID, Nickname: "Host", ResumeTokenHash: tokenHash("host-token"), CanSpeak: true, JoinOrder: 1, IsHost: true}
	first := &Member{ID: "first", RoomID: room.ID, Nickname: "First", ResumeTokenHash: tokenHash("first-token"), CanSpeak: true, JoinOrder: 2, Connected: true}
	second := &Member{ID: "second", RoomID: room.ID, Nickname: "Second", ResumeTokenHash: tokenHash("second-token"), CanSpeak: true, JoinOrder: 3, Connected: true}
	server.mu.Lock()
	server.rooms[room.ID] = room
	server.members[host.ID] = host
	server.members[first.ID] = first
	server.members[second.ID] = second
	if err := server.store.saveRoom(context.Background(), room); err != nil {
		t.Fatal(err)
	}
	for _, member := range []*Member{host, first, second} {
		if err := server.store.saveMember(context.Background(), member); err != nil {
			t.Fatal(err)
		}
	}
	server.mu.Unlock()

	server.sweep(now)
	if room.HostMemberID != first.ID || !first.IsHost || host.IsHost {
		t.Fatalf("host was not transferred atomically: room=%s first=%v old=%v", room.HostMemberID, first.IsHost, host.IsHost)
	}
}

func TestEmptyRoomDeadlineTakesPrecedence(t *testing.T) {
	server := testServer(t)
	now := time.Now().UTC()
	room := &Room{ID: "empty", Name: "Empty", HostMemberID: "host", HostNickname: "Host", MaxParticipants: 25, HostDisconnectTimeoutMinutes: 60, CreatedAt: now, HostReconnectDeadline: now.Add(50 * time.Minute), EmptyDeadline: now.Add(-time.Second)}
	member := &Member{ID: "host", RoomID: room.ID, Nickname: "Host", ResumeTokenHash: tokenHash("host-token"), CanSpeak: true, JoinOrder: 1, IsHost: true}
	server.mu.Lock()
	server.rooms[room.ID] = room
	server.members[member.ID] = member
	if err := server.store.saveRoom(context.Background(), room); err != nil {
		t.Fatal(err)
	}
	if err := server.store.saveMember(context.Background(), member); err != nil {
		t.Fatal(err)
	}
	server.mu.Unlock()

	server.livekit.rooms = nil // This test only covers persisted room-state cleanup.
	server.sweep(now)
	server.mu.Lock()
	_, stillPresent := server.rooms[room.ID]
	server.mu.Unlock()
	if stillPresent {
		t.Fatal("empty room survived even though its 10-minute deadline expired")
	}
}
