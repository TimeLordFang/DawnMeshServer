package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestResumePreservesOfflineRetention(t *testing.T) {
	for _, isHost := range []bool{false, true} {
		t.Run(map[bool]string{false: "guest", true: "host"}[isHost], func(t *testing.T) {
			s := testServer(t)
			now := time.Now().UTC()
			deadline := now.Add(time.Minute)
			room := &Room{ID: "room", Name: "Room", HostMemberID: "host", HostDisconnectTimeoutMinutes: 1, CreatedAt: now}
			member := &Member{ID: "guest", RoomID: room.ID, ResumeTokenHash: tokenHash("token"), ReconnectDeadline: deadline, IsHost: isHost}
			if isHost {
				member.ID = "host"
				room.HostReconnectDeadline = deadline
			}
			s.rooms[room.ID] = room
			s.members[member.ID] = member
			if err := s.store.saveRoom(context.Background(), room); err != nil {
				t.Fatal(err)
			}
			if err := s.store.saveMember(context.Background(), member); err != nil {
				t.Fatal(err)
			}
			token := "token"
			for i := 0; i < 2; i++ {
				body, _ := json.Marshal(map[string]string{"memberId": member.ID, "resumeToken": token})
				r := httptest.NewRequest("POST", "/resume", strings.NewReader(string(body)))
				r.SetPathValue("room", room.ID)
				w := httptest.NewRecorder()
				s.resume(w, r)
				if w.Code != 200 {
					t.Fatalf("%d %s", w.Code, w.Body)
				}
				var grant struct{ ResumeToken string }
				if err := json.Unmarshal(w.Body.Bytes(), &grant); err != nil {
					t.Fatal(err)
				}
				token = grant.ResumeToken
				if member.Connected || !member.ReconnectDeadline.Equal(deadline) {
					t.Fatal("resume renewed offline presence")
				}
				if isHost && !room.HostReconnectDeadline.Equal(deadline) {
					t.Fatal("host handover cancelled")
				}
			}
			if !isHost {
				s.sweep(deadline.Add(time.Second))
				if s.members[member.ID] != nil {
					t.Fatal("offline guest retained")
				}
			}
		})
	}
}
func TestOnlineResumeDoesNotStartExpiry(t *testing.T) {
	s := testServer(t)
	room := &Room{ID: "room", Name: "Room", HostMemberID: "host", CreatedAt: time.Now()}
	m := &Member{ID: "host", RoomID: room.ID, IsHost: true, Connected: true, ResumeTokenHash: tokenHash("token")}
	s.rooms[room.ID] = room
	s.members[m.ID] = m
	_ = s.store.saveRoom(context.Background(), room)
	_ = s.store.saveMember(context.Background(), m)
	r := httptest.NewRequest("POST", "/resume", strings.NewReader(`{"memberId":"host","resumeToken":"token"}`))
	r.SetPathValue("room", room.ID)
	w := httptest.NewRecorder()
	s.resume(w, r)
	if w.Code != 200 || !m.ReconnectDeadline.IsZero() || !room.HostReconnectDeadline.IsZero() {
		t.Fatal("online member given offline deadline")
	}
}
