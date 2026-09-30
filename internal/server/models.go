package server

import "time"

type Room struct {
	HybridAudioEnabled           bool      `json:"hybridAudioEnabled"`
	JoinSalt                     []byte    `json:"-"`
	JoinCredentialHash           []byte    `json:"-"`
	WrappedRoomKey               []byte    `json:"-"`
	PresenceAnnouncementsEnabled bool      `json:"presenceAnnouncementsEnabled"`
	ID                           string    `json:"id"`
	Name                         string    `json:"name"`
	HostMemberID                 string    `json:"-"`
	HostNickname                 string    `json:"hostNickname"`
	MaxParticipants              int       `json:"maxParticipants"`
	HostDisconnectTimeoutMinutes int       `json:"hostDisconnectTimeoutMinutes"`
	CreatedAt                    time.Time `json:"-"`
	HostReconnectDeadline        time.Time `json:"hostReconnectDeadline,omitempty"`
	EmptyDeadline                time.Time `json:"-"`
	MonitoringKey                []byte    `json:"-"`
}

type Member struct {
	DeviceProofHash   []byte    `json:"-"`
	ID                string    `json:"id"`
	RoomID            string    `json:"-"`
	Nickname          string    `json:"nickname"`
	DeviceID          string    `json:"-"`
	ResumeTokenHash   []byte    `json:"-"`
	CanSpeak          bool      `json:"canSpeak"`
	JoinOrder         int       `json:"-"`
	Connected         bool      `json:"connected"`
	ReconnectDeadline time.Time `json:"-"`
	IsHost            bool      `json:"isHost"`
}
