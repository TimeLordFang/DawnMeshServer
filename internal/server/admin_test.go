package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testAdminToken = "admin-access-that-is-at-least-thirty-two-characters"

func TestAdminUIIsEmbeddedAndAPIUsesSeparateCredential(t *testing.T) {
	server := testServer(t)
	handler := server.Handler()

	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/admin/", nil))
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), "DawnMesh 管理后台") {
		t.Fatalf("admin page status=%d body=%q", page.Code, page.Body.String())
	}
	if contentType := page.Header().Get("Content-Type"); !strings.Contains(contentType, "text/html") {
		t.Fatalf("unexpected content type %q", contentType)
	}
	if csp := page.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("missing admin CSP: %q", csp)
	}

	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/admin/app.js", nil))
	if asset.Code != http.StatusOK || !strings.Contains(asset.Body.String(), "sessionStorage") {
		t.Fatalf("embedded asset status=%d", asset.Code)
	}

	styles := httptest.NewRecorder()
	handler.ServeHTTP(styles, httptest.NewRequest(http.MethodGet, "/admin/app.css", nil))
	if styles.Code != http.StatusOK || !strings.Contains(styles.Body.String(), "[hidden] { display: none !important; }") {
		t.Fatalf("embedded stylesheet does not preserve hidden view state: status=%d", styles.Code)
	}

	for name, token := range map[string]string{
		"missing token": "",
		"client token":  "server-access",
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/overview", nil)
			if token != "" {
				request.Header.Set("Authorization", "Bearer "+token)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/overview", nil)
	request.Header.Set("Authorization", "Bearer "+testAdminToken)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("overview status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "server-access") || strings.Contains(response.Body.String(), "ResumeToken") {
		t.Fatalf("overview leaked a credential: %s", response.Body.String())
	}
}

func TestAdminCanRenameMuteAndEndRoom(t *testing.T) {
	server := testServer(t)
	server.livekit.rooms = nil
	now := time.Now().UTC()
	room := &Room{ID: "admin-room", Name: "Before", HostMemberID: "host", HostNickname: "Host", MaxParticipants: 25, HostDisconnectTimeoutMinutes: 10, CreatedAt: now}
	host := &Member{ID: "host", RoomID: room.ID, Nickname: "Host", DeviceID: "host-device-123456789012345", ResumeTokenHash: tokenHash("host-token"), CanSpeak: true, JoinOrder: 1, Connected: true, IsHost: true}
	member := &Member{ID: "member", RoomID: room.ID, Nickname: "Member", DeviceID: "member-device-1234567890123", ResumeTokenHash: tokenHash("member-token"), CanSpeak: true, JoinOrder: 2, Connected: true}

	server.mu.Lock()
	server.rooms[room.ID] = room
	server.members[host.ID] = host
	server.members[member.ID] = member
	if err := server.store.saveRoom(context.Background(), room); err != nil {
		t.Fatal(err)
	}
	for _, item := range []*Member{host, member} {
		if err := server.store.saveMember(context.Background(), item); err != nil {
			t.Fatal(err)
		}
	}
	server.mu.Unlock()

	callAdmin := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+testAdminToken)
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		return response
	}

	rename := callAdmin(http.MethodPatch, "/api/v1/admin/rooms/admin-room", `{"name":"After"}`)
	if rename.Code != http.StatusOK || room.Name != "After" {
		t.Fatalf("rename status=%d room=%q body=%s", rename.Code, room.Name, rename.Body.String())
	}

	mute := callAdmin(http.MethodPut, "/api/v1/admin/rooms/admin-room/members/member/voice-policy", `{"canSpeak":false}`)
	if mute.Code != http.StatusOK || member.CanSpeak {
		t.Fatalf("mute status=%d canSpeak=%v body=%s", mute.Code, member.CanSpeak, mute.Body.String())
	}

	overview := callAdmin(http.MethodGet, "/api/v1/admin/overview", "")
	var payload adminOverviewResponse
	if err := json.Unmarshal(overview.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Rooms) != 1 || len(payload.Rooms[0].Members) != 2 || payload.Rooms[0].Members[1].CanSpeak {
		t.Fatalf("unexpected overview: %#v", payload.Rooms)
	}

	ended := callAdmin(http.MethodDelete, "/api/v1/admin/rooms/admin-room", "")
	if ended.Code != http.StatusOK {
		t.Fatalf("end status=%d body=%s", ended.Code, ended.Body.String())
	}
	server.mu.Lock()
	_, exists := server.rooms[room.ID]
	server.mu.Unlock()
	if exists {
		t.Fatal("room still exists after admin termination")
	}
}

func TestAdminAPIIsDisabledWithoutAdminToken(t *testing.T) {
	server := testServer(t)
	server.cfg.AdminToken = ""
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/overview", nil)
	request.Header.Set("Authorization", "Bearer anything")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
