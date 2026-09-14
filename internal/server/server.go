package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/TimeLordFang/DawnMeshServer/internal/config"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type Server struct {
	cfg        config.Config
	startedAt  time.Time
	store      *store
	livekit    *liveKitManager
	mu         sync.Mutex
	wsWriteMu  sync.Mutex
	rooms      map[string]*Room
	members    map[string]*Member
	admissions map[string]*Admission
	sockets    map[string]map[*websocket.Conn]struct{}
	attempts   map[string][]time.Time
	stop       chan struct{}
}

func New(cfg config.Config) (*Server, error) {
	db, err := openStore(cfg.DatabasePath)
	if err != nil {
		return nil, err
	}
	rooms, members, err := db.load(context.Background())
	if err != nil {
		db.close()
		return nil, err
	}
	server := &Server{cfg: cfg, startedAt: time.Now().UTC(), store: db, livekit: newLiveKitManager(cfg.LiveKitURL, cfg.LiveKitPublicURL, cfg.LiveKitAPIKey, cfg.LiveKitAPISecret), rooms: rooms, members: members, admissions: map[string]*Admission{}, sockets: map[string]map[*websocket.Conn]struct{}{}, attempts: map[string][]time.Time{}, stop: make(chan struct{})}
	now := time.Now().UTC()
	for _, room := range rooms {
		if room.EmptyDeadline.IsZero() {
			room.EmptyDeadline = now.Add(10 * time.Minute)
		}
		if host := members[room.HostMemberID]; host != nil && room.HostReconnectDeadline.IsZero() {
			room.HostReconnectDeadline = now.Add(time.Duration(room.HostDisconnectTimeoutMinutes) * time.Minute)
		}
		_ = db.saveRoom(context.Background(), room)
	}
	for _, member := range members {
		member.Connected = false
		if member.ReconnectDeadline.IsZero() {
			member.ReconnectDeadline = now.Add(10 * time.Minute)
		}
		_ = db.saveMember(context.Background(), member)
	}
	go server.sweeper()
	return server, nil
}

func (s *Server) Close() error { close(s.stop); return s.store.close() }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /admin", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin/", http.StatusPermanentRedirect)
	})
	mux.Handle("GET /admin/", http.StripPrefix("/admin/", adminUIHandler()))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})
	mux.HandleFunc("GET /api/v1/info", s.withAccess(s.info))
	mux.HandleFunc("GET /api/v1/rooms", s.withAccess(s.listRooms))
	mux.HandleFunc("POST /api/v1/rooms", s.withAccess(s.createRoom))
	mux.HandleFunc("POST /api/v1/rooms/{room}/admissions", s.withAccess(s.createAdmission))
	mux.HandleFunc("POST /api/v1/rooms/{room}/resume", s.withAccess(s.resume))
	mux.HandleFunc("PATCH /api/v1/rooms/{room}", s.withSession(s.renameRoom))
	mux.HandleFunc("PUT /api/v1/rooms/{room}/members/{member}/voice-policy", s.withSession(s.voicePolicy))
	mux.HandleFunc("POST /api/v1/rooms/{room}/handover", s.withSession(s.handover))
	mux.HandleFunc("DELETE /api/v1/rooms/{room}/members/{member}", s.withSession(s.leaveMember))
	mux.HandleFunc("DELETE /api/v1/rooms/{room}", s.withSession(s.endRoom))
	mux.HandleFunc("GET /api/v1/events", s.withAccess(s.events))
	mux.HandleFunc("GET /api/v1/admin/overview", s.withAdminAccess(s.adminOverview))
	mux.HandleFunc("PATCH /api/v1/admin/rooms/{room}", s.withAdminAccess(s.adminRenameRoom))
	mux.HandleFunc("PUT /api/v1/admin/rooms/{room}/members/{member}/voice-policy", s.withAdminAccess(s.adminVoicePolicy))
	mux.HandleFunc("DELETE /api/v1/admin/rooms/{room}", s.withAdminAccess(s.adminEndRoom))
	return limitBody(securityHeaders(mux))
}

func (s *Server) withAccess(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.AccessToken != "" && !constantEqual(bearer(r.Header.Get("Authorization")), s.cfg.AccessToken) {
			writeError(w, http.StatusUnauthorized, "服务器访问凭证无效")
			return
		}
		next(w, r)
	}
}

func (s *Server) withSession(next func(http.ResponseWriter, *http.Request, *Member)) http.HandlerFunc {
	return s.withAccess(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Dawn-Session")
		hash := tokenHash(token)
		s.mu.Lock()
		var found *Member
		for _, member := range s.members {
			if subtle.ConstantTimeCompare(member.ResumeTokenHash, hash) == 1 {
				found = member
				break
			}
		}
		s.mu.Unlock()
		if found == nil {
			writeError(w, http.StatusUnauthorized, "会话已失效")
			return
		}
		next(w, r, found)
	})
}

func (s *Server) info(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"instanceId": s.cfg.InstanceID, "name": s.cfg.InstanceName, "protocolVersion": 1, "maxRoomParticipants": s.cfg.MaximumParticipants})
}

func (s *Server) listRooms(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rooms := make([]map[string]any, 0, len(s.rooms))
	for _, room := range s.rooms {
		rooms = append(rooms, s.roomJSON(room))
	}
	sort.Slice(rooms, func(i, j int) bool { return rooms[i]["name"].(string) < rooms[j]["name"].(string) })
	writeJSON(w, http.StatusOK, map[string]any{"rooms": rooms})
}

type createRoomRequest struct {
	Name            string `json:"name"`
	Nickname        string `json:"nickname"`
	DeviceID        string `json:"deviceId"`
	MaxParticipants int    `json:"maxParticipants"`
	HostTimeout     int    `json:"hostDisconnectTimeoutMinutes"`
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	var body createRoomRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Nickname = strings.TrimSpace(body.Nickname)
	if body.Name == "" || !utf8.ValidString(body.Name) || len([]rune(body.Name)) > 80 || body.Nickname == "" || len([]byte(body.Nickname)) > 96 || len(body.DeviceID) < 24 || body.MaxParticipants < 2 || body.MaxParticipants > s.cfg.MaximumParticipants || body.HostTimeout < 1 || body.HostTimeout > 60 {
		writeError(w, http.StatusBadRequest, "房间参数无效")
		return
	}
	roomID := randomID(18)
	memberID := randomID(18)
	resume := randomID(32)
	now := time.Now().UTC()
	room := &Room{ID: roomID, Name: body.Name, HostMemberID: memberID, HostNickname: body.Nickname, MaxParticipants: body.MaxParticipants, HostDisconnectTimeoutMinutes: body.HostTimeout, CreatedAt: now}
	member := &Member{ID: memberID, RoomID: roomID, Nickname: body.Nickname, DeviceID: body.DeviceID, ResumeTokenHash: tokenHash(resume), CanSpeak: true, JoinOrder: 1, IsHost: true}
	s.mu.Lock()
	if len(s.rooms) >= s.cfg.MaximumRooms || !s.allowAttemptLocked("create:ip:"+clientIP(r), 10, time.Minute) || !s.allowAttemptLocked("create:device:"+body.DeviceID, 3, time.Minute) {
		s.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, "建房请求过于频繁或服务器房间已达上限")
		return
	}
	deviceRooms := 0
	for _, existing := range s.members {
		if existing.DeviceID == body.DeviceID && existing.IsHost {
			deviceRooms++
		}
	}
	if deviceRooms >= 3 {
		s.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, "同一设备最多保留 3 个房间")
		return
	}
	s.rooms[roomID] = room
	s.members[memberID] = member
	err1 := s.store.saveRoom(r.Context(), room)
	err2 := s.store.saveMember(r.Context(), member)
	grant, grantErr := s.connectionGrant(room, member, resume)
	s.mu.Unlock()
	if err1 != nil || err2 != nil {
		writeError(w, http.StatusInternalServerError, "无法保存房间")
		return
	}
	if grantErr != nil {
		writeError(w, http.StatusInternalServerError, "无法签发媒体令牌")
		return
	}
	writeJSON(w, http.StatusCreated, grant)
}

type admissionRequest struct {
	Nickname string `json:"nickname"`
	DeviceID string `json:"deviceId"`
}

func (s *Server) createAdmission(w http.ResponseWriter, r *http.Request) {
	var body admissionRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Nickname = strings.TrimSpace(body.Nickname)
	roomID := r.PathValue("room")
	if body.Nickname == "" || len([]byte(body.Nickname)) > 96 || len(body.DeviceID) < 24 {
		writeError(w, http.StatusBadRequest, "成员参数无效")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.allowAttemptLocked("join:ip:"+clientIP(r), 20, time.Minute) || !s.allowAttemptLocked("join:device:"+body.DeviceID, 10, time.Minute) {
		writeError(w, http.StatusTooManyRequests, "加入请求过于频繁，请稍后再试")
		return
	}
	room := s.rooms[roomID]
	if room == nil {
		writeError(w, http.StatusNotFound, "房间不存在")
		return
	}
	if s.memberCount(roomID) >= room.MaxParticipants {
		writeError(w, http.StatusConflict, "房间已满")
		return
	}
	roomPending := 0
	devicePending := 0
	for _, pending := range s.admissions {
		if pending.RoomID == roomID {
			roomPending++
		}
		if pending.DeviceID == body.DeviceID {
			devicePending++
		}
	}
	if len(s.admissions) >= 512 || roomPending >= 8 || devicePending >= 3 {
		writeError(w, http.StatusTooManyRequests, "待验证请求过多，请稍后再试")
		return
	}
	if !s.isOnline(room.HostMemberID) {
		writeError(w, http.StatusConflict, "房主暂时离线，无法验证邀请码")
		return
	}
	resume := randomID(32)
	admission := &Admission{ID: randomID(18), RoomID: roomID, MemberID: randomID(18), Nickname: body.Nickname, DeviceID: body.DeviceID, ResumeToken: resume, ResumeTokenHash: tokenHash(resume), CreatedAt: time.Now().UTC()}
	s.admissions[admission.ID] = admission
	writeJSON(w, http.StatusCreated, map[string]any{"room": s.roomJSON(room), "admissionId": admission.ID, "memberId": admission.MemberID, "resumeToken": resume, "eventsUrl": s.cfg.PublicBaseURL + "/api/v1/events"})
}

type resumeRequest struct {
	MemberID    string `json:"memberId"`
	ResumeToken string `json:"resumeToken"`
}

func (s *Server) resume(w http.ResponseWriter, r *http.Request) {
	var body resumeRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	member := s.members[body.MemberID]
	room := s.rooms[r.PathValue("room")]
	if member == nil || room == nil || member.RoomID != room.ID || subtle.ConstantTimeCompare(member.ResumeTokenHash, tokenHash(body.ResumeToken)) != 1 {
		writeError(w, http.StatusUnauthorized, "恢复凭证无效")
		return
	}
	now := time.Now().UTC()
	deadline := member.ReconnectDeadline
	if member.IsHost && !room.HostReconnectDeadline.IsZero() {
		deadline = room.HostReconnectDeadline
	}
	if !deadline.IsZero() && now.After(deadline) {
		writeError(w, http.StatusGone, "恢复窗口已结束")
		return
	}
	newToken := randomID(32)
	member.ResumeTokenHash = tokenHash(newToken)
	member.ReconnectDeadline = time.Time{}
	if member.IsHost {
		room.HostReconnectDeadline = time.Time{}
	}
	_ = s.store.saveMember(r.Context(), member)
	_ = s.store.saveRoom(r.Context(), room)
	grant, err := s.connectionGrant(room, member, newToken)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "无法签发媒体令牌")
		return
	}
	writeJSON(w, http.StatusOK, grant)
}

func (s *Server) renameRoom(w http.ResponseWriter, r *http.Request, caller *Member) {
	if caller.RoomID != r.PathValue("room") || !caller.IsHost {
		writeError(w, http.StatusForbidden, "只有房主可以改名")
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len([]rune(body.Name)) > 80 {
		writeError(w, http.StatusBadRequest, "房间名无效")
		return
	}
	s.mu.Lock()
	room := s.rooms[caller.RoomID]
	room.Name = body.Name
	_ = s.store.saveRoom(r.Context(), room)
	payload := map[string]any{"type": "room_updated", "room": s.roomJSON(room)}
	s.mu.Unlock()
	s.broadcastRoom(caller.RoomID, payload)
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) voicePolicy(w http.ResponseWriter, r *http.Request, caller *Member) {
	if caller.RoomID != r.PathValue("room") || !caller.IsHost {
		writeError(w, http.StatusForbidden, "只有房主可以管理麦克风")
		return
	}
	var body struct {
		CanSpeak bool `json:"canSpeak"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	targetID := r.PathValue("member")
	s.mu.Lock()
	target := s.members[targetID]
	if target == nil || target.RoomID != caller.RoomID || target.IsHost {
		s.mu.Unlock()
		writeError(w, http.StatusBadRequest, "目标成员无效")
		return
	}
	target.CanSpeak = body.CanSpeak
	_ = s.store.saveMember(r.Context(), target)
	members := s.membersJSON(caller.RoomID)
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.livekit.setCanPublish(ctx, caller.RoomID, targetID, body.CanSpeak); err != nil {
		slog.Warn("livekit permission update failed", "error", err, "member", targetID)
	}
	s.broadcastRoom(caller.RoomID, map[string]any{"type": "voice_policy", "memberId": targetID, "canSpeak": body.CanSpeak, "members": members})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handover(w http.ResponseWriter, r *http.Request, caller *Member) {
	if caller.RoomID != r.PathValue("room") || !caller.IsHost {
		writeError(w, http.StatusForbidden, "只有房主可以移交房间")
		return
	}
	var body struct {
		MemberID string `json:"memberId"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	s.mu.Lock()
	target := s.members[body.MemberID]
	room := s.rooms[caller.RoomID]
	if target == nil || target.RoomID != caller.RoomID || !target.Connected {
		s.mu.Unlock()
		writeError(w, http.StatusBadRequest, "只能移交给在线成员")
		return
	}
	caller.IsHost = false
	target.IsHost = true
	room.HostMemberID = target.ID
	room.HostNickname = target.Nickname
	room.HostReconnectDeadline = time.Time{}
	_ = s.store.saveRoom(r.Context(), room)
	members := s.membersJSON(room.ID)
	s.mu.Unlock()
	s.broadcastRoom(room.ID, map[string]any{"type": "role_changed", "hostMemberId": target.ID, "members": members})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) leaveMember(w http.ResponseWriter, r *http.Request, caller *Member) {
	if caller.ID != r.PathValue("member") || caller.RoomID != r.PathValue("room") {
		writeError(w, http.StatusForbidden, "不能让其他成员离房")
		return
	}
	s.mu.Lock()
	wasHost := caller.IsHost
	delete(s.members, caller.ID)
	_ = s.store.deleteMember(r.Context(), caller.ID)
	room := s.rooms[caller.RoomID]
	if room != nil && caller.IsHost {
		s.assignHostLocked(room)
	}
	roomHasMembers := s.memberCount(caller.RoomID) > 0
	s.mu.Unlock()
	if wasHost && !roomHasMembers {
		s.deleteRoom(r.Context(), caller.RoomID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	s.broadcastSnapshot(caller.RoomID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) endRoom(w http.ResponseWriter, r *http.Request, caller *Member) {
	if caller.RoomID != r.PathValue("room") || !caller.IsHost {
		writeError(w, http.StatusForbidden, "只有房主可以解散房间")
		return
	}
	s.deleteRoom(r.Context(), caller.RoomID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("X-Dawn-Session")
	hash := tokenHash(token)
	s.mu.Lock()
	var member *Member
	var admission *Admission
	for _, item := range s.members {
		if subtle.ConstantTimeCompare(item.ResumeTokenHash, hash) == 1 {
			member = item
			break
		}
	}
	if member == nil {
		for _, item := range s.admissions {
			if subtle.ConstantTimeCompare(item.ResumeTokenHash, hash) == 1 {
				admission = item
				break
			}
		}
	}
	s.mu.Unlock()
	if member == nil && admission == nil {
		writeError(w, http.StatusUnauthorized, "会话无效")
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	socketID := memberID(member, admission)
	s.addSocket(socketID, conn)
	if member != nil {
		s.markConnected(member.ID, true)
		s.send(conn, map[string]any{"type": "snapshot", "room": s.roomJSONSafe(member.RoomID), "hostMemberId": s.hostID(member.RoomID), "canSpeak": member.CanSpeak, "members": s.membersJSONSafe(member.RoomID)})
	}
	readContext := r.Context()
	if admission != nil {
		var cancel context.CancelFunc
		readContext, cancel = context.WithTimeout(readContext, 35*time.Second)
		defer cancel()
	}
	for {
		var event map[string]any
		if err := wsjson.Read(readContext, conn, &event); err != nil {
			break
		}
		if err := s.routeEvent(r.Context(), member, admission, event); err != nil {
			s.send(conn, map[string]any{"type": "error", "error": err.Error()})
		}
	}
	s.removeSocket(socketID, conn)
	if member != nil {
		if !s.hasSocket(socketID) {
			s.markConnected(member.ID, false)
		}
	}
}

func (s *Server) routeEvent(ctx context.Context, member *Member, admission *Admission, event map[string]any) error {
	typeName, _ := event["type"].(string)
	if typeName == "media_ready" {
		if member == nil {
			return errors.New("member required")
		}
		s.mu.Lock()
		canSpeak := member.CanSpeak
		roomID := member.RoomID
		s.mu.Unlock()
		var updateErr error
		for attempt := 0; attempt < 3; attempt++ {
			updateCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			updateErr = s.livekit.setCanPublish(updateCtx, roomID, member.ID, canSpeak)
			cancel()
			if updateErr == nil {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
		return fmt.Errorf("media permission: %w", updateErr)
	}
	admissionID, _ := event["admissionId"].(string)
	body, _ := event["body"].(string)
	if len(body) > 4096 {
		return errors.New("event too large")
	}
	s.mu.Lock()
	pending := s.admissions[admissionID]
	if pending == nil {
		s.mu.Unlock()
		return errors.New("admission expired")
	}
	room := s.rooms[pending.RoomID]
	if room == nil {
		s.mu.Unlock()
		return errors.New("room ended")
	}
	switch typeName {
	case "pake_hello", "pake_confirm":
		if admission == nil || admission.ID != pending.ID {
			s.mu.Unlock()
			return errors.New("invalid admission sender")
		}
		target := room.HostMemberID
		s.mu.Unlock()
		event["memberId"] = pending.MemberID
		s.sendTo(target, event)
		return nil
	case "pake_reply":
		if member == nil || member.ID != room.HostMemberID {
			s.mu.Unlock()
			return errors.New("host required")
		}
		target := pending.MemberID
		s.mu.Unlock()
		s.sendTo(target, event)
		return nil
	case "admission_rejected":
		if member == nil || member.ID != room.HostMemberID {
			s.mu.Unlock()
			return errors.New("host required")
		}
		delete(s.admissions, pending.ID)
		target := pending.MemberID
		s.mu.Unlock()
		s.sendTo(target, event)
		return nil
	case "pake_key":
		if member == nil || member.ID != room.HostMemberID {
			s.mu.Unlock()
			return errors.New("host required")
		}
		if time.Since(pending.CreatedAt) > 30*time.Second {
			s.mu.Unlock()
			return errors.New("admission expired")
		}
		if s.memberCount(room.ID) >= room.MaxParticipants {
			s.mu.Unlock()
			return errors.New("room full")
		}
		joinOrder := 1
		for _, item := range s.members {
			if item.RoomID == room.ID && item.JoinOrder >= joinOrder {
				joinOrder = item.JoinOrder + 1
			}
		}
		joined := &Member{ID: pending.MemberID, RoomID: room.ID, Nickname: pending.Nickname, DeviceID: pending.DeviceID, ResumeTokenHash: pending.ResumeTokenHash, CanSpeak: true, JoinOrder: joinOrder, Connected: false, ReconnectDeadline: time.Now().UTC().Add(10 * time.Minute)}
		s.members[joined.ID] = joined
		delete(s.admissions, pending.ID)
		_ = s.store.saveMember(ctx, joined)
		grant, err := s.connectionGrant(room, joined, pending.ResumeToken)
		s.mu.Unlock()
		if err != nil {
			return err
		}
		event["connection"] = grant
		s.sendTo(joined.ID, event)
		s.broadcastSnapshot(room.ID)
		return nil
	default:
		s.mu.Unlock()
		return errors.New("unsupported event")
	}
}

func (s *Server) connectionGrant(room *Room, member *Member, resume string) (map[string]any, error) {
	token, err := s.livekit.joinToken(room.ID, member.ID, member.Nickname)
	if err != nil {
		return nil, err
	}
	return map[string]any{"room": s.roomJSON(room), "memberId": member.ID, "livekitUrl": s.cfg.LiveKitPublicURL, "livekitToken": token, "resumeToken": resume, "eventsUrl": s.cfg.PublicBaseURL + "/api/v1/events"}, nil
}

func (s *Server) roomJSON(room *Room) map[string]any {
	return map[string]any{"id": room.ID, "name": room.Name, "memberCount": s.memberCount(room.ID), "maxParticipants": room.MaxParticipants, "hostNickname": room.HostNickname, "hostDisconnectTimeoutMinutes": room.HostDisconnectTimeoutMinutes}
}
func (s *Server) memberCount(roomID string) int {
	count := 0
	for _, m := range s.members {
		if m.RoomID == roomID {
			count++
		}
	}
	for _, a := range s.admissions {
		if a.RoomID == roomID {
			count++
		}
	}
	return count
}
func (s *Server) membersJSON(roomID string) []Member {
	result := []Member{}
	for _, m := range s.members {
		if m.RoomID == roomID {
			copy := *m
			copy.IsHost = s.rooms[roomID] != nil && s.rooms[roomID].HostMemberID == m.ID
			result = append(result, copy)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].JoinOrder < result[j].JoinOrder })
	return result
}
func (s *Server) roomJSONSafe(id string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if room := s.rooms[id]; room != nil {
		return s.roomJSON(room)
	}
	return nil
}
func (s *Server) membersJSONSafe(id string) []Member {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.membersJSON(id)
}
func (s *Server) hostID(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if room := s.rooms[id]; room != nil {
		return room.HostMemberID
	}
	return ""
}
func (s *Server) isOnline(id string) bool {
	member := s.members[id]
	return member != nil && member.Connected
}

func (s *Server) markConnected(id string, connected bool) {
	s.mu.Lock()
	member := s.members[id]
	if member == nil {
		s.mu.Unlock()
		return
	}
	room := s.rooms[member.RoomID]
	if room == nil {
		s.mu.Unlock()
		return
	}
	member.Connected = connected
	now := time.Now().UTC()
	if connected {
		member.ReconnectDeadline = time.Time{}
		if member.IsHost {
			room.HostReconnectDeadline = time.Time{}
		}
		room.EmptyDeadline = time.Time{}
	} else {
		member.ReconnectDeadline = now.Add(10 * time.Minute)
		if member.IsHost && room.HostReconnectDeadline.IsZero() {
			room.HostReconnectDeadline = now.Add(time.Duration(room.HostDisconnectTimeoutMinutes) * time.Minute)
		}
		if !s.anyOnline(room.ID) {
			room.EmptyDeadline = now.Add(10 * time.Minute)
		}
	}
	_ = s.store.saveMember(context.Background(), member)
	_ = s.store.saveRoom(context.Background(), room)
	s.mu.Unlock()
	s.broadcastSnapshot(member.RoomID)
}
func (s *Server) anyOnline(roomID string) bool {
	for _, m := range s.members {
		if m.RoomID == roomID && m.Connected {
			return true
		}
	}
	return false
}

func (s *Server) sweeper() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case now := <-ticker.C:
			s.sweep(now.UTC())
		}
	}
}
func (s *Server) sweep(now time.Time) {
	s.mu.Lock()
	changed := map[string]bool{}
	deleteRooms := []string{}
	for id, admission := range s.admissions {
		if now.Sub(admission.CreatedAt) > 30*time.Second {
			delete(s.admissions, id)
		}
	}
	for key, attempts := range s.attempts {
		if len(attempts) == 0 || now.Sub(attempts[len(attempts)-1]) > time.Minute {
			delete(s.attempts, key)
		}
	}
	for _, room := range s.rooms {
		if !room.EmptyDeadline.IsZero() && now.After(room.EmptyDeadline) {
			deleteRooms = append(deleteRooms, room.ID)
			continue
		}
		if !room.HostReconnectDeadline.IsZero() && now.After(room.HostReconnectDeadline) {
			s.assignHostLocked(room)
			changed[room.ID] = true
		}
	}
	for id, member := range s.members {
		if !member.IsHost && !member.Connected && !member.ReconnectDeadline.IsZero() && now.After(member.ReconnectDeadline) {
			delete(s.members, id)
			_ = s.store.deleteMember(context.Background(), id)
			changed[member.RoomID] = true
		}
	}
	s.mu.Unlock()
	for _, id := range deleteRooms {
		s.deleteRoom(context.Background(), id)
	}
	for id := range changed {
		s.broadcastSnapshot(id)
	}
}

func (s *Server) assignHostLocked(room *Room) {
	var candidates []*Member
	for _, m := range s.members {
		if m.RoomID == room.ID && m.Connected {
			candidates = append(candidates, m)
		}
	}
	if len(candidates) == 0 {
		return
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].JoinOrder < candidates[j].JoinOrder })
	old := s.members[room.HostMemberID]
	if old != nil {
		old.IsHost = false
	}
	next := candidates[0]
	next.IsHost = true
	room.HostMemberID = next.ID
	room.HostNickname = next.Nickname
	room.HostReconnectDeadline = time.Time{}
	if old != nil && !old.Connected {
		delete(s.members, old.ID)
		_ = s.store.deleteMember(context.Background(), old.ID)
	}
	_ = s.store.saveRoom(context.Background(), room)
}
func (s *Server) deleteRoom(ctx context.Context, id string) {
	s.mu.Lock()
	if s.rooms[id] == nil {
		s.mu.Unlock()
		return
	}
	connections := []*websocket.Conn{}
	for _, member := range s.members {
		if member.RoomID != id {
			continue
		}
		for connection := range s.sockets[member.ID] {
			connections = append(connections, connection)
		}
	}
	delete(s.rooms, id)
	for memberID, m := range s.members {
		if m.RoomID == id {
			delete(s.members, memberID)
		}
	}
	_ = s.store.deleteRoom(ctx, id)
	s.mu.Unlock()
	for _, connection := range connections {
		s.send(connection, map[string]any{"type": "room_ended"})
	}
	lkctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = s.livekit.deleteRoom(lkctx, id)
}

func (s *Server) addSocket(id string, c *websocket.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sockets[id] == nil {
		s.sockets[id] = map[*websocket.Conn]struct{}{}
	}
	s.sockets[id][c] = struct{}{}
}
func (s *Server) removeSocket(id string, c *websocket.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sockets[id], c)
	if len(s.sockets[id]) == 0 {
		delete(s.sockets, id)
	}
}
func (s *Server) hasSocket(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sockets[id]) > 0
}
func (s *Server) send(c *websocket.Conn, value any) {
	s.wsWriteMu.Lock()
	defer s.wsWriteMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = wsjson.Write(ctx, c, value)
}
func (s *Server) sendTo(id string, value any) {
	s.mu.Lock()
	connections := make([]*websocket.Conn, 0, len(s.sockets[id]))
	for c := range s.sockets[id] {
		connections = append(connections, c)
	}
	s.mu.Unlock()
	for _, c := range connections {
		s.send(c, value)
	}
}
func (s *Server) broadcastRoom(roomID string, value any) {
	s.mu.Lock()
	ids := []string{}
	for _, m := range s.members {
		if m.RoomID == roomID {
			ids = append(ids, m.ID)
		}
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.sendTo(id, value)
	}
}
func (s *Server) broadcastSnapshot(roomID string) {
	s.mu.Lock()
	room := s.rooms[roomID]
	if room == nil {
		s.mu.Unlock()
		return
	}
	value := map[string]any{"type": "snapshot", "room": s.roomJSON(room), "hostMemberId": room.HostMemberID, "members": s.membersJSON(roomID)}
	s.mu.Unlock()
	s.broadcastRoom(roomID, value)
}

func memberID(member *Member, admission *Admission) string {
	if member != nil {
		return member.ID
	}
	return admission.MemberID
}
func randomID(bytes int) string {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(value)
}
func tokenHash(token string) []byte { digest := sha256.Sum256([]byte(token)); return digest[:] }
func bearer(value string) string {
	prefix := "Bearer "
	if strings.HasPrefix(value, prefix) {
		return strings.TrimSpace(strings.TrimPrefix(value, prefix))
	}
	return ""
}
func constantEqual(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remote := net.ParseIP(host)
	if remote != nil && remote.IsLoopback() {
		if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); net.ParseIP(forwarded) != nil {
			return forwarded
		}
	}
	return host
}
func (s *Server) allowAttemptLocked(key string, limit int, window time.Duration) bool {
	now := time.Now().UTC()
	cutoff := now.Add(-window)
	values := s.attempts[key]
	first := 0
	for first < len(values) && values[first].Before(cutoff) {
		first++
	}
	values = append(values[first:], now)
	s.attempts[key] = values
	return len(values) <= limit
}
func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "JSON 请求无效")
		return false
	}
	return true
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}
func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		next.ServeHTTP(w, r)
	})
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}
