package server

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Serialize updates for an identity without holding the room-state lock over
// network IO. Re-read after each call so late retries cannot restore stale policy.
func (s *Server) syncMediaPolicy(ctx context.Context, memberID string) error {
	lock := &s.mediaPolicyLocks[int(tokenHash(memberID)[0])%len(s.mediaPolicyLocks)]
	lock.Lock()
	defer lock.Unlock()
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		s.mu.Lock()
		member := s.members[memberID]
		if member == nil || s.rooms[member.RoomID] == nil {
			s.mu.Unlock()
			return errors.New("member no longer in room")
		}
		roomID := member.RoomID
		allowed := s.rooms[roomID].HostMemberID == memberID || member.CanSpeak
		s.mu.Unlock()
		updateCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		lastErr = s.livekit.setCanPublish(updateCtx, roomID, memberID, allowed)
		cancel()
		s.mu.Lock()
		current := s.members[memberID]
		room := s.rooms[roomID]
		unchanged := current != nil && room != nil && (room.HostMemberID == memberID || current.CanSpeak) == allowed
		s.mu.Unlock()
		if lastErr == nil && unchanged {
			return nil
		}
		if lastErr == nil {
			lastErr = errors.New("policy changed during media update")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return fmt.Errorf("media permission: %w", lastErr)
}
