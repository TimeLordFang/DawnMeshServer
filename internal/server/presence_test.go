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

func TestPresenceSettingRequiresCurrentHostAndSurvivesReload(t *testing.T) {
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
		r := httptest.NewRequest(http.MethodPut, "/api/v1/rooms/"+room.ID+"/presence-announcements", strings.NewReader(body))
		r.SetPathValue("room", room.ID)
		w := httptest.NewRecorder()
		s.setPresenceAnnouncements(w, r, caller)
		return w.Code
	}
	if code := put(guest, `{"enabled":true}`); code != http.StatusForbidden {
		t.Fatalf("guest status %d", code)
	}
	if code := put(host, `{}`); code != http.StatusBadRequest {
		t.Fatalf("missing flag status %d", code)
	}
	if code := put(host, `{"enabled":true}`); code != http.StatusOK {
		t.Fatalf("host status %d", code)
	}
	rooms, _, err := s.store.load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !rooms[room.ID].PresenceAnnouncementsEnabled {
		t.Fatal("setting lost on reload")
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
	if rooms[room.ID].PresenceAnnouncementsEnabled {
		t.Fatal("disable not persisted")
	}
}

func TestPresenceDisconnectAndExplicitLeaveHaveDistinctEvents(t *testing.T) {
	s := testServer(t)
	room := &Room{ID: "room", Name: "Room", HostMemberID: "host", MaxParticipants: 25, CreatedAt: time.Now(), HostDisconnectTimeoutMinutes: 30}
	host := &Member{ID: "host", RoomID: room.ID, IsHost: true, Connected: true, ResumeTokenHash: tokenHash("host-token")}
	guest := &Member{ID: "guest", RoomID: room.ID, Nickname: "Guest", Connected: true, ResumeTokenHash: tokenHash("guest-token")}
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
	stream := make(eventStream, 8)
	s.eventStreams[host.ID] = map[eventStream]struct{}{stream: {}}
	s.markConnected(guest.ID, false)
	var event map[string]any
	if err := json.Unmarshal(<-stream, &event); err != nil {
		t.Fatal(err)
	}
	if event["type"] != "snapshot" {
		t.Fatalf("disconnect emitted %v", event["type"])
	}
	if _, exists := s.members[guest.ID]; !exists {
		t.Fatal("offline identity removed")
	}
	r := httptest.NewRequest(http.MethodDelete, "/", nil)
	r.SetPathValue("room", room.ID)
	r.SetPathValue("member", guest.ID)
	w := httptest.NewRecorder()
	s.leaveMember(w, r, guest)
	if w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	if err := json.Unmarshal(<-stream, &event); err != nil {
		t.Fatal(err)
	}
	if event["type"] != "member_left" || event["memberId"] != guest.ID || event["eventId"] == "" {
		t.Fatalf("leave event: %v", event)
	}
	if _, exists := s.members[guest.ID]; exists {
		t.Fatal("explicitly departed identity retained")
	}
}
