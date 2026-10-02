package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPublicRoomRejectsLegacyHybridEnableButAllowsClearingPreference(t *testing.T) {
	s := testServer(t)
	room := &Room{ID: "presence-room", Name: "Room", HostMemberID: "host", MaxParticipants: 25, CreatedAt: time.Now(), HostDisconnectTimeoutMinutes: 30}
	host := &Member{ID: "host", RoomID: room.ID, Nickname: "Host", IsHost: true, ResumeTokenHash: tokenHash("host-token")}
	guest := &Member{ID: "guest", RoomID: room.ID, Nickname: "Guest", ResumeTokenHash: tokenHash("guest-token")}
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
	put := func(caller *Member, body string) int {
		r := httptest.NewRequest(http.MethodPut, "/api/v1/rooms/"+room.ID+"/hybrid-audio", strings.NewReader(body))
		r.SetPathValue("room", room.ID)
		w := httptest.NewRecorder()
		s.setHybridAudio(w, r, caller)
		return w.Code
	}
	if code := put(guest, `{"enabled":false}`); code != http.StatusForbidden {
		t.Fatalf("guest status %d", code)
	}
	if code := put(host, `{}`); code != http.StatusBadRequest {
		t.Fatalf("missing flag status %d", code)
	}
	if code := put(host, `{"enabled":true}`); code != http.StatusConflict {
		t.Fatalf("host status %d", code)
	}
	rooms, _, err := s.store.load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rooms[room.ID].HybridAudioEnabled {
		t.Fatal("public hybrid unexpectedly enabled")
	}
	// A formerly-host caller can still hold a stale role object: the room's host ID wins.
	room.HostMemberID = guest.ID
	if code := put(host, `{"enabled":false}`); code != http.StatusForbidden {
		t.Fatalf("old host status %d", code)
	}
	if code := put(guest, `{"enabled":false}`); code != http.StatusOK {
		t.Fatalf("new host status %d", code)
	}
	rooms, _, err = s.store.load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rooms[room.ID].HybridAudioEnabled {
		t.Fatal("disable not persisted")
	}
	s.cfg.ClientFeaturesPath = "/nonexistent/features.json"
	if code := put(guest, `{"enabled":true}`); code != http.StatusConflict {
		t.Fatalf("global disable bypassed: %d", code)
	}
	if code := put(guest, `{"enabled":false}`); code != http.StatusOK {
		t.Fatalf("disable must remain allowed: %d", code)
	}

}
