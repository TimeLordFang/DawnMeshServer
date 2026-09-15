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

	liveKitAsset := httptest.NewRecorder()
	handler.ServeHTTP(liveKitAsset, httptest.NewRequest(http.MethodGet, "/admin/vendor/livekit-client.umd.js", nil))
	if liveKitAsset.Code != http.StatusOK || !strings.Contains(liveKitAsset.Body.String(), "LivekitClient") {
		t.Fatalf("embedded LiveKit browser SDK status=%d", liveKitAsset.Code)
	}
	if !strings.Contains(asset.Body.String(), "keyProvider.setKey(new TextEncoder().encode(grant.e2eeKey))") || strings.Contains(asset.Body.String(), "keyProvider.setKey(grant.e2eeKey)") {
		t.Fatal("admin listener must use the native-compatible media key bytes")
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

func TestAdminListeningRequiresHostEscrowAndTracksLifetime(t *testing.T) {
	server := testServer(t)
	handler := server.Handler()
	encodedKey := base64.URLEncoding.EncodeToString(make([]byte, 32))
	createBody := `{"name":"可监听房间","nickname":"房主","deviceId":"123456789012345678901234","maxParticipants":25,"hostDisconnectTimeoutMinutes":10,"monitoringKey":"` + encodedKey + `"}`
	createRequest := httptest.NewRequest(http.MethodPost, "/api/v1/rooms", strings.NewReader(createBody))
	createRequest.Header.Set("Authorization", "Bearer server-access")
	createResponse := httptest.NewRecorder()
	handler.ServeHTTP(createResponse, createRequest)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", createResponse.Code, createResponse.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(createResponse.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	roomID := created["room"].(map[string]any)["id"].(string)

	call := func(method, path string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, nil)
		request.Header.Set("Authorization", "Bearer "+testAdminToken)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	started := call(http.MethodPost, "/api/v1/admin/rooms/"+roomID+"/listen")
	if started.Code != http.StatusCreated {
		t.Fatalf("listen status=%d body=%s", started.Code, started.Body.String())
	}
	var grant map[string]any
	if err := json.Unmarshal(started.Body.Bytes(), &grant); err != nil {
		t.Fatal(err)
	}
	if grant["e2eeKey"] != encodedKey || grant["livekitToken"] == "" {
		t.Fatalf("unexpected listening grant: %#v", grant)
	}
	parts := strings.Split(grant["livekitToken"].(string), ".")
	if len(parts) != 3 {
		t.Fatal("invalid listener JWT")
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
	if video["canPublish"] != false || video["canSubscribe"] != true || video["canPublishData"] != false || video["hidden"] != true {
		t.Fatalf("listener grant is not hidden and subscribe-only: %#v", video)
	}
	listenerID := grant["listenerId"].(string)
	if response := call(http.MethodPut, "/api/v1/admin/listeners/"+listenerID); response.Code != http.StatusOK {
		t.Fatalf("heartbeat status=%d body=%s", response.Code, response.Body.String())
	}
	server.mu.Lock()
	active := server.monitorCountLocked(roomID)
	server.mu.Unlock()
	if active != 1 {
		t.Fatalf("active listeners=%d, want 1", active)
	}
	if response := call(http.MethodDelete, "/api/v1/admin/listeners/"+listenerID); response.Code != http.StatusOK {
		t.Fatalf("stop status=%d body=%s", response.Code, response.Body.String())
	}
	server.mu.Lock()
	active = server.monitorCountLocked(roomID)
	server.mu.Unlock()
	if active != 0 {
		t.Fatalf("active listeners=%d after stop", active)
	}
}

func TestAdminListeningIsUnavailableWithoutHostEscrow(t *testing.T) {
	server := testServer(t)
	room := &Room{ID: "private-room", Name: "Private", HostMemberID: "host", HostNickname: "Host", MaxParticipants: 25, HostDisconnectTimeoutMinutes: 10, CreatedAt: time.Now().UTC()}
	server.mu.Lock()
	server.rooms[room.ID] = room
	server.mu.Unlock()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/rooms/private-room/listen", nil)
	request.Header.Set("Authorization", "Bearer "+testAdminToken)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
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
