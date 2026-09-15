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
		MemberID    string `json:"memberId"`
		Room        struct {
			ID     string `json:"id"`
			IsHost bool   `json:"isHost"`
		} `json:"room"`
	}
	if err := json.NewDecoder(createResponse.Body).Decode(&grant); err != nil {
		t.Fatal(err)
	}
	if !grant.Room.IsHost {
		t.Fatal("create grant did not identify the browser as room host")
	}

	mediaRequest, err := http.NewRequest(http.MethodPost, httpServer.URL+"/api/v1/rooms/"+grant.Room.ID+"/media-grant", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	mediaRequest.Header.Set("Authorization", "Bearer server-access")
	mediaRequest.Header.Set("X-Dawn-Session", grant.ResumeToken)
	mediaRequest.Header.Set("Content-Type", "application/json")
	mediaResponse, err := http.DefaultClient.Do(mediaRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer mediaResponse.Body.Close()
	if mediaResponse.StatusCode != http.StatusOK {
		t.Fatalf("media grant status=%d", mediaResponse.StatusCode)
	}
	var mediaGrant struct {
		LiveKitToken string `json:"livekitToken"`
	}
	if err := json.NewDecoder(mediaResponse.Body).Decode(&mediaGrant); err != nil {
		t.Fatal(err)
	}
	if mediaGrant.LiveKitToken == "" {
		t.Fatal("media grant did not include a LiveKit token")
	}

	protocol := func(name, value string) string {
		return name + "." + base64.RawURLEncoding.EncodeToString([]byte(value))
	}
	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/api/v1/events"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(ctx, websocketURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://talk.example.test"}},
		Subprotocols: []string{
			browserEventProtocol,
			protocol("dawn-access", "server-access"),
			protocol("dawn-session", grant.ResumeToken),
		},
	})
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

func TestEventSocketHeartbeatKeepsConnectionResponsive(t *testing.T) {
	handlerDone := make(chan struct{})
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerDone)
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept heartbeat socket: %v", err)
			return
		}
		defer connection.CloseNow()
		readContext := connection.CloseRead(r.Context())
		keepEventSocketAlive(readContext, connection, "heartbeat-test", 5*time.Millisecond)
	}))
	defer httpServer.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	readContext := connection.CloseRead(ctx)
	time.Sleep(30 * time.Millisecond)
	if err := connection.Ping(readContext); err != nil {
		t.Fatalf("connection stopped responding after server heartbeats: %v", err)
	}
	if err := connection.Close(websocket.StatusNormalClosure, "done"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-handlerDone:
	case <-ctx.Done():
		t.Fatal("heartbeat handler did not stop after client close")
	}
}

func TestHTTPEventStreamFallbackReceivesManagementEvents(t *testing.T) {
	server := testServer(t)
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()

	createRequest, err := http.NewRequest(http.MethodPost, httpServer.URL+"/api/v1/rooms", strings.NewReader(`{
      "name":"Fallback Room","nickname":"Fallback Host","deviceId":"fallback-device-1234567890123456",
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
	var grant struct {
		ResumeToken string `json:"resumeToken"`
		Room        struct {
			ID string `json:"id"`
		} `json:"room"`
	}
	if err := json.NewDecoder(createResponse.Body).Decode(&grant); err != nil {
		t.Fatal(err)
	}

	streamContext, cancelStream := context.WithCancel(context.Background())
	defer cancelStream()
	streamRequest, err := http.NewRequestWithContext(streamContext, http.MethodGet, httpServer.URL+"/api/v1/events/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	streamRequest.Header.Set("Authorization", "Bearer server-access")
	streamRequest.Header.Set("X-Dawn-Session", grant.ResumeToken)
	streamResponse, err := http.DefaultClient.Do(streamRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer streamResponse.Body.Close()
	if streamResponse.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d", streamResponse.StatusCode)
	}
	decoder := json.NewDecoder(streamResponse.Body)
	readEvent := func() map[string]any {
		t.Helper()
		result := make(chan map[string]any, 1)
		failure := make(chan error, 1)
		go func() {
			var event map[string]any
			if err := decoder.Decode(&event); err != nil {
				failure <- err
				return
			}
			result <- event
		}()
		select {
		case event := <-result:
			return event
		case err := <-failure:
			t.Fatalf("decode stream event: %v", err)
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for stream event")
		}
		return nil
	}
	if event := readEvent(); event["type"] != "snapshot" {
		t.Fatalf("first stream event=%v", event)
	}

	renameRequest, err := http.NewRequest(http.MethodPatch, httpServer.URL+"/api/v1/rooms/"+grant.Room.ID, strings.NewReader(`{"name":"Renamed over HTTP"}`))
	if err != nil {
		t.Fatal(err)
	}
	renameRequest.Header.Set("Authorization", "Bearer server-access")
	renameRequest.Header.Set("X-Dawn-Session", grant.ResumeToken)
	renameRequest.Header.Set("Content-Type", "application/json")
	renameResponse, err := http.DefaultClient.Do(renameRequest)
	if err != nil {
		t.Fatal(err)
	}
	renameResponse.Body.Close()
	if renameResponse.StatusCode != http.StatusOK {
		t.Fatalf("rename status=%d", renameResponse.StatusCode)
	}
	if event := readEvent(); event["type"] != "room_updated" {
		t.Fatalf("broadcast stream event=%v", event)
	}

	sendRequest, err := http.NewRequest(http.MethodPost, httpServer.URL+"/api/v1/events/send", strings.NewReader(`{"type":"unsupported"}`))
	if err != nil {
		t.Fatal(err)
	}
	sendRequest.Header.Set("Authorization", "Bearer server-access")
	sendRequest.Header.Set("X-Dawn-Session", grant.ResumeToken)
	sendRequest.Header.Set("Content-Type", "application/json")
	sendResponse, err := http.DefaultClient.Do(sendRequest)
	if err != nil {
		t.Fatal(err)
	}
	sendResponse.Body.Close()
	if sendResponse.StatusCode != http.StatusBadRequest {
		t.Fatalf("send status=%d", sendResponse.StatusCode)
	}
}
