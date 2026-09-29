package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDeviceRejoinPreservesIdentityPolicyAndCapacity(t *testing.T) {
	s, room, host, guest := policyFixture(t)
	room.MaxParticipants = 2
	credential := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	proof := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32))
	room.JoinCredentialHash = tokenHash(credential)
	guest.DeviceID = strings.Repeat("device", 4)
	guest.DeviceProofHash = deviceProofHash(proof)
	guest.Connected = false
	if err := s.store.saveMember(context.Background(), guest); err != nil {
		t.Fatal(err)
	}
	join := func(key string) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(map[string]string{"nickname": "Same name", "deviceId": guest.DeviceID, "deviceProof": key, "joinCredential": credential})
		r := httptest.NewRequest("POST", "/", bytes.NewReader(raw))
		r.SetPathValue("room", room.ID)
		w := httptest.NewRecorder()
		s.joinRoom(w, r)
		return w
	}
	if w := join(base64.StdEncoding.EncodeToString(make([]byte, 32))); w.Code != 403 {
		t.Fatal(w.Code, w.Body)
	}
	oldToken := append([]byte{}, guest.ResumeTokenHash...)
	w := join(proof)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body)
	}
	var grant map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &grant)
	if grant["memberId"] != guest.ID || len(s.members) != 2 {
		t.Fatal("duplicate identity or full room rejoin failed")
	}
	current := s.members[guest.ID]
	if current.CanSpeak || current.JoinOrder != guest.JoinOrder || current.IsHost || bytes.Equal(current.ResumeTokenHash, oldToken) {
		t.Fatal("policy changed or token not rotated")
	}
	if s.routeEvent(context.Background(), guest, map[string]any{"type": "media_ready"}) == nil {
		t.Fatal("old connection can still issue commands")
	}
	_, members, err := s.store.load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(members[guest.ID].DeviceProofHash, deviceProofHash(proof)) {
		t.Fatal("proof not durable")
	}
	// A host returning through Join must retain the role, even with a full room.
	host.DeviceID = guest.DeviceID + "host"
	host.DeviceProofHash = deviceProofHash(proof)
	guest.DeviceID = host.DeviceID // request target only; previous guest pointer is stale
	w = join(proof)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body)
	}
	_ = json.Unmarshal(w.Body.Bytes(), &grant)
	if grant["memberId"] != host.ID || grant["room"].(map[string]any)["isHost"] != true {
		t.Fatal("host rejoined as guest")
	}
}
