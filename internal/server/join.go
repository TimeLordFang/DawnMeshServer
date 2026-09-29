package server

import (
	"crypto/subtle"
	"encoding/base64"
	"github.com/coder/websocket"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// Admission is independent of the host's control and media connections.
// Only a verifier hash and an opaque, client-encrypted random room key persist.
func (s *Server) joinRoom(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceProof string `json:"deviceProof"`
		Nickname    string `json:"nickname"`
		DeviceID    string `json:"deviceId"`
		Credential  string `json:"joinCredential"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.DeviceProof != "" && !validDeviceProof(body.DeviceProof) {
		writeError(w, 400, "设备凭证无效")
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
	var previous *Member
	for _, m := range s.members {
		if m.RoomID == roomID && m.DeviceID == body.DeviceID && len(m.DeviceProofHash) == 0 && body.DeviceProof != "" {
			s.mu.Unlock()
			writeError(w, http.StatusConflict, "旧会话尚未绑定设备凭证，请先退出旧会话或由房主移除后重新加入")
			return
		}
		if m.RoomID == roomID && m.DeviceID == body.DeviceID && len(m.DeviceProofHash) > 0 {
			if subtle.ConstantTimeCompare(m.DeviceProofHash, deviceProofHash(body.DeviceProof)) != 1 {
				s.mu.Unlock()
				writeError(w, http.StatusForbidden, "设备恢复凭证不匹配")
				return
			}
			previous = m
			break
		}
	}
	if previous == nil && s.memberCount(roomID) >= room.MaxParticipants {
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
	member := &Member{DeviceProofHash: deviceProofHash(body.DeviceProof), ID: randomID(18), RoomID: roomID, Nickname: body.Nickname, DeviceID: body.DeviceID,
		ResumeTokenHash: tokenHash(resume), CanSpeak: true, JoinOrder: order, ReconnectDeadline: time.Now().UTC().Add(reconnectRetention)}
	if previous != nil {
		copy := *previous
		member = &copy
		member.Nickname = body.Nickname
		member.ResumeTokenHash = tokenHash(resume)
		member.ReconnectDeadline = time.Now().UTC().Add(reconnectRetention)
	}
	grant, err := s.connectionGrant(room, member, resume)
	if err == nil {
		err = s.store.saveMember(r.Context(), member)
	}
	if err != nil {
		s.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "无法加入房间")
		return
	}
	oldSockets := make([]*websocket.Conn, 0)
	oldStreams := make([]eventStream, 0)
	if previous != nil {
		for stream := range s.eventStreams[member.ID] {
			oldStreams = append(oldStreams, stream)
		}
		for conn := range s.sockets[member.ID] {
			oldSockets = append(oldSockets, conn)
		}
	}
	s.members[member.ID] = member
	// Refresh the count only after the durable member is installed.
	grant["room"] = s.roomJSON(room)
	grant["room"].(map[string]any)["isHost"] = member.ID == room.HostMemberID
	grant["wrappedRoomKey"] = base64.StdEncoding.EncodeToString(room.WrappedRoomKey)
	s.mu.Unlock()
	for _, stream := range oldStreams {
		select {
		case stream <- []byte("{\"type\":\"session_replaced\"}\n"):
		default:
		}
	}
	for _, conn := range oldSockets {
		s.send(conn, map[string]any{"type": "session_replaced"})
		conn.CloseNow()
	}
	s.broadcastSnapshot(roomID)
	writeJSON(w, http.StatusCreated, grant)
}

func validDeviceProof(proof string) bool {
	bytes, err := base64.StdEncoding.DecodeString(proof)
	return err == nil && len(bytes) == 32 && base64.StdEncoding.EncodeToString(bytes) == proof
}
func deviceProofHash(proof string) []byte {
	if proof == "" {
		return nil
	}
	return tokenHash(proof)
}
