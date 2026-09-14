package server

import "time"

type Room struct {
	ID                           string    `json:"id"`
	Name                         string    `json:"name"`
	HostMemberID                 string    `json:"-"`
	HostNickname                 string    `json:"hostNickname"`
	MaxParticipants              int       `json:"maxParticipants"`
	HostDisconnectTimeoutMinutes int       `json:"hostDisconnectTimeoutMinutes"`
	CreatedAt                    time.Time `json:"-"`
	HostReconnectDeadline        time.Time `json:"hostReconnectDeadline,omitempty"`
	EmptyDeadline                time.Time `json:"-"`
}

type Member struct {
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

type Admission struct {
	ID              string
	RoomID          string
	MemberID        string
	Nickname        string
	DeviceID        string
	ResumeToken     string
	ResumeTokenHash []byte
	CreatedAt       time.Time
}
