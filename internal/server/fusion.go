package server

// Fusion rooms use the Android room's PAKE + encrypted Opus protocol. This
// relay cannot grant admission or decrypt media. Any admitted member can upload
// the creator's signed roster, including members who have never been online.
import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

type fusionHub struct {
	mu    sync.Mutex
	rooms map[string]*fusionRoom
}
type fusionRoom struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Members    []fusionMember `json:"members"`
	Revision   uint64         `json:"revision"`
	manifest   []byte
	state      []byte
	secretHash []byte
	ended      bool
	updated    time.Time
	peers      map[*fusionPeer]struct{}
	seen       map[[32]byte]time.Time
	lastPruned time.Time
}
type fusionMember struct {
	ID       int    `json:"id"`
	DeviceID string `json:"deviceId"`
	Nickname string `json:"nickname"`
}
type fusionPeer struct {
	out    chan []byte
	cancel context.CancelFunc
}

func newFusionHub() *fusionHub { return &fusionHub{rooms: make(map[string]*fusionRoom)} }
func (h *fusionHub) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.rooms {
		for p := range r.peers {
			p.cancel()
		}
	}
}
func (h *fusionHub) prune(now time.Time) {
	for id, r := range h.rooms {
		if now.Sub(r.updated) > 30*time.Minute {
			for p := range r.peers {
				p.cancel()
			}
			delete(h.rooms, id)
		}
	}
}

func parseFusion(id string, manifest, state []byte, now time.Time) (*fusionRoom, error) {
	bad := errors.New("invalid signed fusion room")
	if len(manifest) < 129 || len(manifest) > 193 || manifest[0] != 1 {
		return nil, bad
	}
	pub := ed25519.PublicKey(manifest[1:33])
	if base64.RawURLEncoding.EncodeToString(pub) != id || !ed25519.Verify(pub, manifest[:len(manifest)-64], manifest[len(manifest)-64:]) {
		return nil, bad
	}
	name := manifest[65 : len(manifest)-64]
	if !utf8.Valid(name) || len(state) < 74 || len(state) > 422 || state[8] > 1 || state[9] > 6 {
		return nil, bad
	}
	body := append(append([]byte{2}, pub...), state[:len(state)-64]...)
	if !ed25519.Verify(pub, body, state[len(state)-64:]) {
		return nil, bad
	}
	revision := binary.BigEndian.Uint64(state[:8])
	if revision > uint64(now.Add(time.Minute).UnixMilli()) || revision < uint64(now.Add(-90*time.Second).UnixMilli()) {
		return nil, bad
	}
	result := &fusionRoom{ID: id, Name: string(name), Revision: revision, manifest: manifest, state: state, secretHash: manifest[33:65], ended: state[8] == 1, updated: now, peers: map[*fusionPeer]struct{}{}, seen: map[[32]byte]time.Time{}}
	offset := 10
	ids := map[byte]bool{}
	devices := map[string]bool{}
	for i := 0; i < int(state[9]); i++ {
		if offset+18 > len(state)-64 {
			return nil, bad
		}
		memberID := state[offset]
		length := int(state[offset+17])
		if memberID < 1 || memberID > 6 || ids[memberID] || length > 40 || offset+18+length > len(state)-64 {
			return nil, bad
		}
		device := base64.RawURLEncoding.EncodeToString(state[offset+1 : offset+17])
		nickname := state[offset+18 : offset+18+length]
		if devices[device] || !utf8.Valid(nickname) {
			return nil, bad
		}
		ids[memberID] = true
		devices[device] = true
		result.Members = append(result.Members, fusionMember{int(memberID), device, string(nickname)})
		offset += 18 + length
	}
	if offset != len(state)-64 || (!result.ended && !ids[1]) {
		return nil, bad
	}
	return result, nil
}

func fusionKeyMatches(key string, hash []byte) bool {
	decoded, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(decoded) != 32 {
		return false
	}
	sum := sha256.Sum256(decoded)
	return constantEqual(string(sum[:]), string(hash))
}

func (s *Server) syncFusion(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Manifest []byte `json:"manifest"`
		State    []byte `json:"state"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048)).Decode(&input) != nil {
		writeError(w, 400, "无效融合房数据")
		return
	}
	room, err := parseFusion(r.PathValue("room"), input.Manifest, input.State, time.Now())
	if err != nil || !fusionKeyMatches(r.Header.Get("X-Fusion-Key"), roomHash(room)) {
		writeError(w, 403, "融合房签名或凭证无效")
		return
	}
	h := s.fusion
	h.mu.Lock()
	defer h.mu.Unlock()
	h.prune(time.Now())
	old := h.rooms[room.ID]
	if old != nil {
		if old.ended || !bytes.Equal(old.manifest, room.manifest) || room.Revision < old.Revision || (room.Revision == old.Revision && !bytes.Equal(old.state, room.state)) {
			writeError(w, 409, "融合房状态已更新或解散")
			return
		}
		room.peers = old.peers
		room.seen = old.seen
		room.lastPruned = old.lastPruned
	} else if len(h.rooms) >= 256 {
		writeError(w, 429, "融合房数量已达上限")
		return
	}
	h.rooms[room.ID] = room
	if room.ended {
		// Allow the signed end packet already in flight to reach every route.
		for p := range room.peers {
			time.AfterFunc(3*time.Second, p.cancel)
		}
	}
	writeJSON(w, 200, map[string]any{"revision": room.Revision})
}
func roomHash(r *fusionRoom) []byte {
	if r == nil {
		return nil
	}
	return r.secretHash
}

func (s *Server) listFusion(w http.ResponseWriter, r *http.Request) {
	h := s.fusion
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	h.prune(now)
	rooms := make([]*fusionRoom, 0)
	for _, room := range h.rooms {
		if !room.ended && now.Sub(time.UnixMilli(int64(room.Revision))) < 90*time.Second && len(room.peers) > 0 {
			rooms = append(rooms, room)
		}
	}
	writeJSON(w, 200, map[string]any{"protocolVersion": 1, "rooms": rooms})
}

func validFusionPacket(data []byte) bool {
	if len(data) < 6 || len(data) > 518 || int(binary.BigEndian.Uint16(data[4:6])) != len(data)-6 {
		return false
	}
	return data[0] == 0x09 || data[0] == 0x0a || data[0] == 0x0b
}

func (s *Server) relayFusion(w http.ResponseWriter, r *http.Request) {
	h := s.fusion
	id := r.PathValue("room")
	h.mu.Lock()
	room := h.rooms[id]
	if room == nil || room.ended || time.Since(time.UnixMilli(int64(room.Revision))) > 90*time.Second || len(room.peers) >= 18 {
		h.mu.Unlock()
		writeError(w, 404, "融合房暂不可达")
		return
	}
	hash := append([]byte(nil), room.secretHash...)
	authenticated := fusionKeyMatches(r.Header.Get("X-Fusion-Key"), hash)
	h.mu.Unlock()
	if r.Header.Get("X-Fusion-Key") != "" && !authenticated {
		writeError(w, 403, "融合房凭证无效")
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1024)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	p := &fusionPeer{out: make(chan []byte, 128), cancel: cancel}
	h.mu.Lock()
	room = h.rooms[id]
	if room == nil || room.ended || len(room.peers) >= 18 {
		h.mu.Unlock()
		return
	}
	room.peers[p] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if current := h.rooms[id]; current != nil {
			delete(current.peers, p)
		}
		h.mu.Unlock()
	}()
	deadline := time.AfterFunc(20*time.Second, cancel)
	defer deadline.Stop()
	if authenticated {
		deadline.Stop()
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-ctx.Done():
				return
			case packet := <-p.out:
				writeCtx, stop := context.WithTimeout(ctx, 3*time.Second)
				err := conn.Write(writeCtx, websocket.MessageBinary, packet)
				stop()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-done }()
	window := time.Now()
	count := 0
	sealed := 0
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		now := time.Now()
		if now.Sub(window) >= time.Second {
			window = now
			count = 0
		}
		count++
		if count > 400 || (!authenticated && count > 12) {
			return
		}
		if kind == websocket.MessageText {
			var auth struct {
				Key string `json:"key"`
			}
			if json.Unmarshal(data, &auth) != nil || !fusionKeyMatches(auth.Key, hash) {
				return
			}
			authenticated = true
			deadline.Stop()
			continue
		}
		if !validFusionPacket(data) {
			return
		}
		if !authenticated && data[0] == 0x0b {
			sealed++
			if sealed > 16 {
				return
			}
		}
		digest := sha256.Sum256(data)
		h.mu.Lock()
		current := h.rooms[id]
		if current == nil || (current.ended && now.Sub(current.updated) > 3*time.Second) {
			h.mu.Unlock()
			return
		}
		if now.Sub(current.lastPruned) > time.Second {
			for key, t := range current.seen {
				if now.Sub(t) > 15*time.Second {
					delete(current.seen, key)
				}
			}
			current.lastPruned = now
		}
		if _, exists := current.seen[digest]; !exists && len(current.seen) < 8192 {
			current.seen[digest] = now
			for peer := range current.peers {
				if peer != p {
					select {
					case peer.out <- data:
					default:
						peer.cancel()
					}
				}
			}
		}
		h.mu.Unlock()
	}
}
