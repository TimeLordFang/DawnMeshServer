package server

import (
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// Admission is independent of the host's control and media connections.
// Only a verifier hash and an opaque, client-encrypted random room key persist.
func (s *Server) joinRoom(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Nickname   string `json:"nickname"`
		DeviceID   string `json:"deviceId"`
		Credential string `json:"joinCredential"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Nickname = strings.TrimSpace(body.Nickname)
	credential, err := base64.StdEncoding.DecodeString(body.Credential)
	if body.Nickname == "" || !utf8.ValidString(body.Nickname) || len([]byte(body.Nickname)) > 96 || len(body.DeviceID) < 24 || err != nil || len(credential) != 32 {
		writeError(w, http.StatusBadRequest, "入房参数无效")
		return
	}
	roomID := r.PathValue("room")
	s.mu.Lock()
	if !s.allowAttemptLocked("join:ip:"+clientIP(r), 20, time.Minute) ||
		!s.allowAttemptLocked("join:device:"+body.DeviceID, 10, time.Minute) ||
		!s.allowAttemptLocked("join:room:"+roomID, 30, time.Minute) {
		s.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, "加入请求过于频繁，请稍后再试")
		return
	}
	room := s.rooms[roomID]
	if room == nil {
		s.mu.Unlock()
		writeError(w, http.StatusNotFound, "房间不存在")
		return
	}
	if len(room.JoinCredentialHash) != 32 {
		s.mu.Unlock()
		writeError(w, http.StatusConflict, "请使用最新客户端重新创建房间")
		return
	}
	// Canonical encoding avoids multiple representations of the same credential.
	if subtle.ConstantTimeCompare(room.JoinCredentialHash, tokenHash(base64.StdEncoding.EncodeToString(credential))) != 1 {
		s.mu.Unlock()
		writeError(w, http.StatusForbidden, "邀请码不正确")
		return
	}
	if s.memberCount(roomID) >= room.MaxParticipants {
		s.mu.Unlock()
		writeError(w, http.StatusConflict, "房间已满")
		return
	}
	order := 1
	for _, m := range s.members {
		if m.RoomID == roomID && m.JoinOrder >= order {
			order = m.JoinOrder + 1
		}
	}
	resume := randomID(32)
	member := &Member{ID: randomID(18), RoomID: roomID, Nickname: body.Nickname, DeviceID: body.DeviceID,
		ResumeTokenHash: tokenHash(resume), CanSpeak: true, JoinOrder: order, ReconnectDeadline: time.Now().UTC().Add(reconnectRetention)}
	grant, err := s.connectionGrant(room, member, resume)
	if err == nil {
		err = s.store.saveMember(r.Context(), member)
	}
	if err != nil {
		s.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "无法加入房间")
		return
	}
	s.members[member.ID] = member
	// Refresh the count only after the durable member is installed.
	grant["room"] = s.roomJSON(room)
	grant["wrappedRoomKey"] = base64.StdEncoding.EncodeToString(room.WrappedRoomKey)
	s.mu.Unlock()
	s.broadcastSnapshot(roomID)
	writeJSON(w, http.StatusCreated, grant)
}
