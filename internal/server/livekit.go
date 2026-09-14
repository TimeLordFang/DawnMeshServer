package server

import (
	"context"
	"time"

	"github.com/livekit/protocol/auth"
	livekit "github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

type liveKitManager struct {
	publicURL string
	key       string
	secret    string
	rooms     *lksdk.RoomServiceClient
}

func newLiveKitManager(serverURL, publicURL, key, secret string) *liveKitManager {
	return &liveKitManager{publicURL: publicURL, key: key, secret: secret, rooms: lksdk.NewRoomServiceClient(serverURL, key, secret)}
}

func (m *liveKitManager) joinToken(room, identity, name string) (string, error) {
	canPublish := false
	canSubscribe := true
	canPublishData := true
	grant := &auth.VideoGrant{RoomJoin: true, Room: room, CanPublish: &canPublish, CanSubscribe: &canSubscribe, CanPublishData: &canPublishData}
	return auth.NewAccessToken(m.key, m.secret).SetVideoGrant(grant).SetIdentity(identity).SetName(name).SetValidFor(2 * time.Minute).ToJWT()
}

func (m *liveKitManager) setCanPublish(ctx context.Context, room, identity string, value bool) error {
	_, err := m.rooms.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room:       room,
		Identity:   identity,
		Permission: &livekit.ParticipantPermission{CanSubscribe: true, CanPublish: value, CanPublishData: true},
	})
	return err
}

func (m *liveKitManager) deleteRoom(ctx context.Context, room string) error {
	if m.rooms == nil {
		return nil
	}
	_, err := m.rooms.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: room})
	return err
}
