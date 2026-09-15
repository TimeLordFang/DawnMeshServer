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

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestClientUIIsEmbeddedAndOnlyClientMayUseMicrophone(t *testing.T) {
	server := testServer(t)
	handler := server.Handler()

	redirect := httptest.NewRecorder()
	handler.ServeHTTP(redirect, httptest.NewRequest(http.MethodGet, "/client", nil))
	if redirect.Code != http.StatusPermanentRedirect || redirect.Header().Get("Location") != "/client/" {
		t.Fatalf("client redirect status=%d location=%q", redirect.Code, redirect.Header().Get("Location"))
	}

	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/client/", nil))
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), "曙光之声 · 网页对讲") {
		t.Fatalf("client page status=%d body=%q", page.Code, page.Body.String())
	}
	if policy := page.Header().Get("Permissions-Policy"); !strings.Contains(policy, "microphone=(self)") {
		t.Fatalf("client microphone policy=%q", policy)
	}

	admin := httptest.NewRecorder()
	handler.ServeHTTP(admin, httptest.NewRequest(http.MethodGet, "/admin/", nil))
	if policy := admin.Header().Get("Permissions-Policy"); !strings.Contains(policy, "microphone=()") {
		t.Fatalf("admin microphone policy was relaxed: %q", policy)
	}

	for _, asset := range []string{"app.css", "app.js", "crypto.js", "vendor/livekit-client.umd.js", "vendor/livekit-client.e2ee.worker.js"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/client/"+asset, nil))
		if response.Code != http.StatusOK || response.Body.Len() == 0 {
			t.Fatalf("embedded client asset %s status=%d size=%d", asset, response.Code, response.Body.Len())
		}
	}
}

func TestBrowserWebSocketSubprotocolAuthenticatesWithoutURLCredentials(t *testing.T) {
	server := testServer(t)
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()

	createRequest, err := http.NewRequest(http.MethodPost, httpServer.URL+"/api/v1/rooms", strings.NewReader(`{
      "name":"浏览器房间","nickname":"网页房主","deviceId":"browser-device-1234567890123456",
      "maxParticipants":25,"hostDisconnectTimeoutMinutes":10}`))
	if err != nil {
		t.Fatal(err)
	}
	createRequest.Header.Set("Authorization", "Bearer server-access")
	createRequest.Header.Set("Content-Type", "application/json")
	createResponse, err := http.DefaultClient.Do(createRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer createResponse.Body.Close()
	if createResponse.StatusCode != http.StatusCreated {
		t.Fatalf("create status=%d", createResponse.StatusCode)
	}
	var grant struct {
		ResumeToken string `json:"resumeToken"`
	}
	if err := json.NewDecoder(createResponse.Body).Decode(&grant); err != nil {
		t.Fatal(err)
	}

	protocol := func(name, value string) string {
		return name + "." + base64.RawURLEncoding.EncodeToString([]byte(value))
	}
	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/api/v1/events"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(ctx, websocketURL, &websocket.DialOptions{Subprotocols: []string{
		browserEventProtocol,
		protocol("dawn-access", "server-access"),
		protocol("dawn-session", grant.ResumeToken),
	}})
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("browser websocket dial status=%d error=%v", status, err)
	}
	defer connection.CloseNow()
	if connection.Subprotocol() != browserEventProtocol {
		t.Fatalf("negotiated subprotocol=%q", connection.Subprotocol())
	}
	var snapshot map[string]any
	if err := wsjson.Read(ctx, connection, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot["type"] != "snapshot" {
		t.Fatalf("first browser event=%#v", snapshot)
	}

	bad, response, err := websocket.Dial(ctx, websocketURL, &websocket.DialOptions{Subprotocols: []string{
		browserEventProtocol,
		protocol("dawn-access", "wrong"),
		protocol("dawn-session", grant.ResumeToken),
	}})
	if bad != nil {
		bad.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid browser access credential status=%v error=%v", response, err)
	}
}
