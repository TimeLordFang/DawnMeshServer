package server

import (
	"context"
	livekit "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func policyFixture(t *testing.T) (*Server, *Room, *Member, *Member) {
	s := testServer(t)
	s.livekit.rooms = nil
	room := &Room{ID: "policy", HostMemberID: "host", CreatedAt: time.Now(), HostDisconnectTimeoutMinutes: 30}
	host := &Member{ID: "host", RoomID: room.ID, IsHost: true, CanSpeak: true, Connected: true, ResumeTokenHash: tokenHash("host"), JoinOrder: 1}
	guest := &Member{ID: "guest", RoomID: room.ID, Connected: true, CanSpeak: false, ResumeTokenHash: tokenHash("guest"), JoinOrder: 2}
	s.rooms[room.ID] = room
	s.members[host.ID] = host
	s.members[guest.ID] = guest
	if err := s.store.saveRoom(context.Background(), room); err != nil {
		t.Fatal(err)
	}
	for _, m := range []*Member{host, guest} {
		if err := s.store.saveMember(context.Background(), m); err != nil {
			t.Fatal(err)
		}
	}
	return s, room, host, guest
}
func TestMutedMemberPromotedToHostRestoresPersistedPolicy(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		s, room, host, guest := policyFixture(t)
		if automatic {
			s.mu.Lock()
			host.Connected = false
			s.assignHostLocked(room)
			s.mu.Unlock()
		} else {
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"memberId":"guest"}`))
			r.SetPathValue("room", room.ID)
			w := httptest.NewRecorder()
			s.handover(w, r, host)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
		}
		if !guest.IsHost || !guest.CanSpeak {
			t.Fatal("new host remains muted")
		}
		_, members, err := s.store.load(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !members[guest.ID].CanSpeak {
			t.Fatal("promotion not persisted")
		}
		// Repair a database written by an older release with a muted host.
		guest.CanSpeak = false
		_ = s.store.saveMember(context.Background(), guest)
		_, members, err = s.store.load(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !members[guest.ID].CanSpeak {
			t.Fatal("old host policy not repaired on reload")
		}
	}
}
func TestMediaSyncReReadsPolicyAfterFailedAndConcurrentUpdates(t *testing.T) {
	s, room, _, guest := policyFixture(t)
	guest.CanSpeak = true
	var mu sync.Mutex
	var grants []bool
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		var request livekit.UpdateParticipantRequest
		if err := proto.Unmarshal(data, &request); err != nil {
			t.Error(err)
			http.Error(w, "bad", 400)
			return
		}
		mu.Lock()
		grants = append(grants, request.Permission.CanPublish)
		count := len(grants)
		mu.Unlock()
		if count == 1 {
			s.mu.Lock()
			guest.CanSpeak = false
			s.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"code":"unavailable","msg":"retry"}`))
			return
		}
		w.Header().Set("Content-Type", "application/protobuf")
		_, _ = w.Write([]byte{})
	}))
	defer endpoint.Close()
	s.livekit = newLiveKitManager(endpoint.URL, "wss://media.test", "key", "long-test-secret")
	if err := s.syncMediaPolicy(context.Background(), guest.ID); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(grants) < 2 || grants[0] != true || grants[len(grants)-1] != false {
		t.Fatalf("stale policy retried: %v", grants)
	}
	mu.Unlock()
	// A host never inherits a deny, even if its in-memory persisted flag is stale.
	s.mu.Lock()
	room.HostMemberID = guest.ID
	guest.IsHost = true
	s.mu.Unlock()
	if err := s.syncMediaPolicy(context.Background(), guest.ID); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !grants[len(grants)-1] {
		t.Fatal("host denied by stale flag")
	}
}
