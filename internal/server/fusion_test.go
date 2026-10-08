package server

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fusionFixture struct {
	id, key  string
	manifest []byte
	private  ed25519.PrivateKey
}

func newFusionFixture(t *testing.T) fusionFixture {
	t.Helper()
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	hash := sha256.Sum256(secret)
	body := append(append(append([]byte{1}, pub...), hash[:]...), []byte("Offline room")...)
	return fusionFixture{base64.RawURLEncoding.EncodeToString(pub), base64.StdEncoding.EncodeToString(secret), append(body, ed25519.Sign(private, body)...), private}
}
func (f fusionFixture) state(revision uint64, ended bool) []byte {
	body := make([]byte, 10)
	binary.BigEndian.PutUint64(body, revision)
	if ended {
		body[8] = 1
	}
	body[9] = 2
	for i := byte(1); i <= 2; i++ {
		body = append(body, i)
		body = append(body, bytes.Repeat([]byte{i}, 16)...)
		body = append(body, 1, 'A'+i)
	}
	signed := append(append([]byte{2}, f.private.Public().(ed25519.PublicKey)...), body...)
	return append(body, ed25519.Sign(f.private, signed)...)
}
func uploadFusion(t *testing.T, s *Server, f fusionFixture, state []byte, key string) int {
	t.Helper()
	body, _ := json.Marshal(map[string][]byte{"manifest": f.manifest, "state": state})
	req := httptest.NewRequest("PUT", "/api/v1/fusion/rooms/"+f.id, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer server-access")
	req.Header.Set("X-Fusion-Key", key)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return w.Code
}

func TestFusionSignedOfflineRosterAndReplayProtection(t *testing.T) {
	s := testServer(t)
	f := newFusionFixture(t)
	rev := uint64(time.Now().UnixMilli())
	state := f.state(rev, false)
	if code := uploadFusion(t, s, f, state, f.key); code != 200 {
		t.Fatal(code)
	}
	if len(s.fusion.rooms[f.id].Members) != 2 {
		t.Fatal("offline member missing")
	}
	if code := uploadFusion(t, s, f, state, f.key); code != 200 {
		t.Fatal("second gateway cannot upload same roster", code)
	}
	if code := uploadFusion(t, s, f, state, "wrong"); code != 403 {
		t.Fatal("bad capability accepted", code)
	}
	modified := append([]byte(nil), state...)
	modified[29] ^= 1
	if code := uploadFusion(t, s, f, modified, f.key); code != 403 {
		t.Fatal("modified offline roster accepted", code)
	}
	if code := uploadFusion(t, s, f, f.state(rev-1, false), f.key); code != 409 {
		t.Fatal("older gateway overwrote roster", code)
	}
	if code := uploadFusion(t, s, f, f.state(rev+1, true), f.key); code != 200 {
		t.Fatal(code)
	}
	if code := uploadFusion(t, s, f, f.state(rev+2, false), f.key); code != 409 {
		t.Fatal("dissolved room resurrected", code)
	}
	other := newFusionFixture(t)
	old := uint64(time.Now().Add(-2 * time.Minute).UnixMilli())
	if code := uploadFusion(t, s, other, other.state(old, false), other.key); code != 403 {
		t.Fatal("stale signed snapshot recreated room", code)
	}
}

func TestFusionMultipleGatewaysDeduplicateAndAllowPAKEBeforeAdmission(t *testing.T) {
	s := testServer(t)
	f := newFusionFixture(t)
	if code := uploadFusion(t, s, f, f.state(uint64(time.Now().UnixMilli()), false), f.key); code != 200 {
		t.Fatal(code)
	}
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dial := func(key string) *websocket.Conn {
		t.Helper()
		header := http.Header{"Authorization": []string{"Bearer server-access"}}
		if key != "" {
			header.Set("X-Fusion-Key", key)
		}
		conn, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http", "ws", 1)+"/api/v1/fusion/rooms/"+f.id+"/relay", &websocket.DialOptions{HTTPHeader: header})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.CloseNow() })
		return conn
	}
	a, b, guest := dial(f.key), dial(f.key), dial("")
	send := func(conn *websocket.Conn, data []byte) {
		t.Helper()
		if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
			t.Fatal(err)
		}
	}
	read := func(conn *websocket.Conn, want []byte) {
		t.Helper()
		_, data, err := conn.Read(ctx)
		if err != nil || !bytes.Equal(data, want) {
			t.Fatalf("got %x err %v want %x", data, err, want)
		}
	}
	hello := []byte{9, 0, 0, 1, 0, 1, 10}
	send(guest, hello)
	read(a, hello)
	read(b, hello)
	response := []byte{10, 1, 0, 2, 0, 1, 20}
	send(a, response)
	read(b, response)
	read(guest, response)
	// Both uplinks received the offline host's same response. Its second copy
	// must not appear ahead of the next unique packet at the remote receiver.
	send(b, response)
	next := []byte{11, 1, 0, 3, 0, 1, 30}
	send(a, next)
	read(guest, next)
	auth, _ := json.Marshal(map[string]string{"key": f.key})
	if err := guest.Write(ctx, websocket.MessageText, auth); err != nil {
		t.Fatal(err)
	}
	packet := []byte{11, 3, 0, 4, 0, 1, 40}
	send(guest, packet)
	read(a, packet)
	// Lose one gateway: the other connection continues independently.
	a.CloseNow()
	read(b, next)
	read(b, packet)
	next = []byte{11, 1, 0, 5, 0, 1, 50}
	send(b, next)
	read(guest, next)
}

func TestFusionNeverRelaysPlaintextAudio(t *testing.T) {
	if validFusionPacket([]byte{1, 1, 0, 1, 0, 1, 42}) {
		t.Fatal("plaintext audio accepted")
	}
	if validFusionPacket([]byte{11, 1, 0, 1, 0, 2, 42}) {
		t.Fatal("truncated packet accepted")
	}
}

func TestFusionAdmittedPeersReconnectWithoutCreatorAndRenewOnlyActiveRoom(t *testing.T) {
	s := testServer(t)
	f := newFusionFixture(t)
	if code := uploadFusion(t, s, f, f.state(uint64(time.Now().UnixMilli()), false), f.key); code != 200 {
		t.Fatal(code)
	}
	// Simulate a creator whose signed roster is old, with an existing retained room.
	s.fusion.mu.Lock()
	s.fusion.rooms[f.id].Revision = uint64(time.Now().Add(-2 * time.Minute).UnixMilli())
	s.fusion.mu.Unlock()
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dial := func(key string) (*websocket.Conn, *http.Response, error) {
		header := http.Header{"Authorization": []string{"Bearer server-access"}}
		if key != "" {
			header.Set("X-Fusion-Key", key)
		}
		return websocket.Dial(ctx, strings.Replace(httpServer.URL, "http", "ws", 1)+"/api/v1/fusion/rooms/"+f.id+"/relay", &websocket.DialOptions{HTTPHeader: header})
	}
	for _, key := range []string{"", "wrong"} {
		conn, response, err := dial(key)
		if err == nil {
			conn.CloseNow()
			t.Fatal("unadmitted device resumed stale room")
		}
		if response == nil || response.StatusCode != 404 {
			t.Fatal("expected stale admission rejection", response, err)
		}
	}
	a, _, err := dial(f.key)
	if err != nil {
		t.Fatal(err)
	}
	defer a.CloseNow()
	b, _, err := dial(f.key)
	if err != nil {
		t.Fatal(err)
	}
	defer b.CloseNow()
	s.fusion.mu.Lock()
	s.fusion.rooms[f.id].updated = time.Now().Add(-29 * time.Minute)
	revision := s.fusion.rooms[f.id].Revision
	s.fusion.mu.Unlock()
	packet := []byte{11, 2, 0, 1, 0, 1, 42}
	if err := a.Write(ctx, websocket.MessageBinary, packet); err != nil {
		t.Fatal(err)
	}
	_, received, err := b.Read(ctx)
	if err != nil || !bytes.Equal(received, packet) {
		t.Fatal("peer relay lost without creator", err)
	}
	s.fusion.mu.Lock()
	current := s.fusion.rooms[f.id]
	if time.Since(current.updated) > time.Second || current.Revision != revision {
		s.fusion.mu.Unlock()
		t.Fatal("activity must refresh retention, never forge a newer signed roster")
	}
	current.ended = true
	s.fusion.mu.Unlock()
	conn, response, err := dial(f.key)
	if err == nil {
		conn.CloseNow()
		t.Fatal("ended room resumed")
	}
	if response == nil || response.StatusCode != 404 {
		t.Fatal(err)
	}
	s.fusion.mu.Lock()
	current.ended = false
	current.updated = time.Now().Add(-31 * time.Minute)
	s.fusion.mu.Unlock()
	conn, _, err = dial(f.key)
	if err == nil {
		conn.CloseNow()
		t.Fatal("expired inactive room resumed")
	}
}

func (f fusionFixture) stateWithCount(revision uint64, count int) []byte {
	body := make([]byte, 10)
	binary.BigEndian.PutUint64(body, revision)
	body[9] = byte(count)
	name := []byte(strings.Repeat("名", 13) + "X") // Exactly 40 UTF-8 bytes.
	for i := 1; i <= count; i++ {
		body = append(body, byte(i))
		body = append(body, bytes.Repeat([]byte{byte(i)}, 16)...)
		body = append(body, byte(len(name)))
		body = append(body, name...)
	}
	signed := append(append([]byte{2}, f.private.Public().(ed25519.PublicKey)...), body...)
	return append(body, ed25519.Sign(f.private, signed)...)
}

func TestFusionSixteenMemberLongRosterAndOverflow(t *testing.T) {
	s := testServer(t)
	f := newFusionFixture(t)
	rev := uint64(time.Now().UnixMilli())
	state := f.stateWithCount(rev, 16)
	if len(state) != fusionMaxStateBytes {
		t.Fatalf("unexpected maximum roster size %d", len(state))
	}
	if code := uploadFusion(t, s, f, state, f.key); code != 200 {
		t.Fatalf("16-member roster rejected: %d", code)
	}
	if len(s.fusion.rooms[f.id].Members) != 16 {
		t.Fatal("truncated roster")
	}
	if code := uploadFusion(t, s, f, f.stateWithCount(rev+1, 17), f.key); code != 403 {
		t.Fatalf("17-member roster accepted: %d", code)
	}
	if len(s.fusion.rooms[f.id].Members) != 16 {
		t.Fatal("invalid roster replaced existing state")
	}
}

func TestFusionSixteenRelayConnectionsHandleFullRoomPacketRate(t *testing.T) {
	s := testServer(t)
	f := newFusionFixture(t)
	if code := uploadFusion(t, s, f, f.stateWithCount(uint64(time.Now().UnixMilli()), 16), f.key); code != 200 {
		t.Fatal(code)
	}
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	peers := make([]*websocket.Conn, 16)
	for i := range peers {
		conn, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http", "ws", 1)+"/api/v1/fusion/rooms/"+f.id+"/relay", &websocket.DialOptions{HTTPHeader: http.Header{"X-Fusion-Key": []string{f.key}, "Authorization": []string{"Bearer server-access"}}})
		if err != nil {
			t.Fatal(err)
		}
		peers[i] = conn
		defer conn.CloseNow()
	}
	// 800 packets model a full room's 20ms voice-frame rate and exceed the
	// old 400/s limit. All 15 receiving connections drain simultaneously.
	const packets = 800
	errors := make(chan error, 15)
	for _, peer := range peers[:15] {
		go func(conn *websocket.Conn) {
			for i := 0; i < packets; i++ {
				_, data, err := conn.Read(ctx)
				if err != nil {
					errors <- err
					return
				}
				if len(data) != 7 || binary.BigEndian.Uint16(data[2:4]) != uint16(i) {
					errors <- fmt.Errorf("wrong relay sequence %x", data)
					return
				}
			}
			errors <- nil
		}(peer)
	}
	for i := 0; i < packets; i++ {
		data := []byte{11, 16, 0, 0, 0, 1, 42}
		binary.BigEndian.PutUint16(data[2:4], uint16(i))
		if err := peers[15].Write(ctx, websocket.MessageBinary, data); err != nil {
			t.Fatal(err)
		}
		// Keep the burst below one second, without overflowing bounded writers.
		if i%10 == 0 {
			time.Sleep(time.Millisecond)
		}
	}
	for i := 0; i < 15; i++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
}
