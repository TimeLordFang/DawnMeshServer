package server

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type adminOverviewResponse struct {
	Instance adminInstance `json:"instance"`
	Totals   adminTotals   `json:"totals"`
	Rooms    []adminRoom   `json:"rooms"`
	Now      time.Time     `json:"now"`
}

type adminInstance struct {
	ID                      string `json:"id"`
	Name                    string `json:"name"`
	UptimeMS                int64  `json:"uptimeMs"`
	MaximumRooms            int    `json:"maximumRooms"`
	MaximumRoomParticipants int    `json:"maximumRoomParticipants"`
}

type adminTotals struct {
	Rooms             int `json:"rooms"`
	Members           int `json:"members"`
	ConnectedMembers  int `json:"connectedMembers"`
	PendingAdmissions int `json:"pendingAdmissions"`
}

type adminRoom struct {
	ID                           string        `json:"id"`
	Name                         string        `json:"name"`
	HostMemberID                 string        `json:"hostMemberId"`
	HostNickname                 string        `json:"hostNickname"`
	MaxParticipants              int           `json:"maxParticipants"`
	HostDisconnectTimeoutMinutes int           `json:"hostDisconnectTimeoutMinutes"`
	CreatedAt                    time.Time     `json:"createdAt"`
	HostReconnectDeadline        *time.Time    `json:"hostReconnectDeadline,omitempty"`
	EmptyDeadline                *time.Time    `json:"emptyDeadline,omitempty"`
	PendingAdmissions            int           `json:"pendingAdmissions"`
	Members                      []adminMember `json:"members"`
}

type adminMember struct {
	ID                string     `json:"id"`
	Nickname          string     `json:"nickname"`
	CanSpeak          bool       `json:"canSpeak"`
	Connected         bool       `json:"connected"`
	IsHost            bool       `json:"isHost"`
	ReconnectDeadline *time.Time `json:"reconnectDeadline,omitempty"`
}

func (s *Server) withAdminAccess(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.AdminToken == "" {
			writeError(w, http.StatusServiceUnavailable, "后台管理未启用")
			return
		}
		if !constantEqual(bearer(r.Header.Get("Authorization")), s.cfg.AdminToken) {
			s.mu.Lock()
			allowed := s.allowAttemptLocked("admin:ip:"+clientIP(r), 10, time.Minute)
			s.mu.Unlock()
			if !allowed {
				writeError(w, http.StatusTooManyRequests, "登录尝试过多，请稍后再试")
				return
			}
			writeError(w, http.StatusUnauthorized, "管理员凭证无效")
			return
		}
		next(w, r)
	}
}

func (s *Server) adminOverview(w http.ResponseWriter, _ *http.Request) {
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()

	response := adminOverviewResponse{
		Instance: adminInstance{
			ID:                      s.cfg.InstanceID,
			Name:                    s.cfg.InstanceName,
			UptimeMS:                now.Sub(s.startedAt).Milliseconds(),
			MaximumRooms:            s.cfg.MaximumRooms,
			MaximumRoomParticipants: s.cfg.MaximumParticipants,
		},
		Totals: adminTotals{
			Rooms:             len(s.rooms),
			Members:           len(s.members),
			PendingAdmissions: len(s.admissions),
		},
		Rooms: make([]adminRoom, 0, len(s.rooms)),
		Now:   now,
	}

	for _, member := range s.members {
		if member.Connected {
			response.Totals.ConnectedMembers++
		}
	}
	for _, room := range s.rooms {
		item := adminRoom{
			ID:                           room.ID,
			Name:                         room.Name,
			HostMemberID:                 room.HostMemberID,
			HostNickname:                 room.HostNickname,
			MaxParticipants:              room.MaxParticipants,
			HostDisconnectTimeoutMinutes: room.HostDisconnectTimeoutMinutes,
			CreatedAt:                    room.CreatedAt,
			HostReconnectDeadline:        timePointer(room.HostReconnectDeadline),
			EmptyDeadline:                timePointer(room.EmptyDeadline),
			Members:                      []adminMember{},
		}
		for _, member := range s.members {
			if member.RoomID != room.ID {
				continue
			}
			item.Members = append(item.Members, adminMember{
				ID:                member.ID,
				Nickname:          member.Nickname,
				CanSpeak:          member.CanSpeak,
				Connected:         member.Connected,
				IsHost:            member.ID == room.HostMemberID,
				ReconnectDeadline: timePointer(member.ReconnectDeadline),
			})
		}
		for _, admission := range s.admissions {
			if admission.RoomID == room.ID {
				item.PendingAdmissions++
			}
		}
		sort.Slice(item.Members, func(i, j int) bool {
			if item.Members[i].IsHost != item.Members[j].IsHost {
				return item.Members[i].IsHost
			}
			return item.Members[i].Nickname < item.Members[j].Nickname
		})
		response.Rooms = append(response.Rooms, item)
	}
	sort.Slice(response.Rooms, func(i, j int) bool {
		return response.Rooms[i].CreatedAt.After(response.Rooms[j].CreatedAt)
	})
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) adminRenameRoom(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || !utf8.ValidString(body.Name) || len([]rune(body.Name)) > 80 {
		writeError(w, http.StatusBadRequest, "房间名无效")
		return
	}

	roomID := r.PathValue("room")
	s.mu.Lock()
	room := s.rooms[roomID]
	if room == nil {
		s.mu.Unlock()
		writeError(w, http.StatusNotFound, "房间不存在")
		return
	}
	previous := room.Name
	room.Name = body.Name
	if err := s.store.saveRoom(r.Context(), room); err != nil {
		room.Name = previous
		s.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "无法保存房间")
		return
	}
	payload := map[string]any{"type": "room_updated", "room": s.roomJSON(room)}
	s.mu.Unlock()
	s.broadcastRoom(roomID, payload)
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) adminVoicePolicy(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CanSpeak bool `json:"canSpeak"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	roomID := r.PathValue("room")
	targetID := r.PathValue("member")
	s.mu.Lock()
	target := s.members[targetID]
	if s.rooms[roomID] == nil || target == nil || target.RoomID != roomID || target.ID == s.rooms[roomID].HostMemberID {
		s.mu.Unlock()
		writeError(w, http.StatusBadRequest, "目标成员无效")
		return
	}
	previous := target.CanSpeak
	target.CanSpeak = body.CanSpeak
	if err := s.store.saveMember(r.Context(), target); err != nil {
		target.CanSpeak = previous
		s.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "无法保存成员设置")
		return
	}
	members := s.membersJSON(roomID)
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.livekit.setCanPublish(ctx, roomID, targetID, body.CanSpeak); err != nil {
		// The persisted policy is authoritative and will be applied again when
		// the participant reconnects or reports media readiness.
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "mediaUpdatePending": true})
	} else {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mediaUpdatePending": false})
	}
	s.broadcastRoom(roomID, map[string]any{"type": "voice_policy", "memberId": targetID, "canSpeak": body.CanSpeak, "members": members})
}

func (s *Server) adminEndRoom(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("room")
	s.mu.Lock()
	exists := s.rooms[roomID] != nil
	s.mu.Unlock()
	if !exists {
		writeError(w, http.StatusNotFound, "房间不存在")
		return
	}
	s.deleteRoom(r.Context(), roomID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func timePointer(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	copy := value
	return &copy
}
