package server

import (
	"context"
	"database/sql"
	"time"

	_ "modernc.org/sqlite"
)

type store struct{ db *sql.DB }

func openStore(path string) (*store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &store{db: db}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS rooms (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, host_member_id TEXT NOT NULL, host_nickname TEXT NOT NULL,
 max_participants INTEGER NOT NULL, host_timeout_minutes INTEGER NOT NULL, created_at INTEGER NOT NULL,
 host_reconnect_deadline INTEGER, empty_deadline INTEGER
);
CREATE TABLE IF NOT EXISTS members (
 id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, nickname TEXT NOT NULL,
 device_id TEXT NOT NULL, resume_token_hash BLOB NOT NULL, can_speak INTEGER NOT NULL, join_order INTEGER NOT NULL,
 reconnect_deadline INTEGER
);
CREATE INDEX IF NOT EXISTS members_room_order ON members(room_id, join_order);
CREATE TABLE IF NOT EXISTS room_monitor_keys (
 room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
 wrapped_key BLOB NOT NULL
);
`)
	return err
}

func millis(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.UnixMilli()
}
func timestamp(value sql.NullInt64) time.Time {
	if !value.Valid {
		return time.Time{}
	}
	return time.UnixMilli(value.Int64).UTC()
}

func (s *store) saveRoom(ctx context.Context, room *Room) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO rooms VALUES(?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET name=excluded.name,host_member_id=excluded.host_member_id,host_nickname=excluded.host_nickname,
max_participants=excluded.max_participants,host_timeout_minutes=excluded.host_timeout_minutes,
host_reconnect_deadline=excluded.host_reconnect_deadline,empty_deadline=excluded.empty_deadline`,
		room.ID, room.Name, room.HostMemberID, room.HostNickname, room.MaxParticipants,
		room.HostDisconnectTimeoutMinutes, room.CreatedAt.UnixMilli(), millis(room.HostReconnectDeadline), millis(room.EmptyDeadline))
	return err
}

func (s *store) saveMember(ctx context.Context, member *Member) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO members VALUES(?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname,resume_token_hash=excluded.resume_token_hash,
can_speak=excluded.can_speak,join_order=excluded.join_order,reconnect_deadline=excluded.reconnect_deadline`,
		member.ID, member.RoomID, member.Nickname, member.DeviceID, member.ResumeTokenHash, member.CanSpeak, member.JoinOrder, millis(member.ReconnectDeadline))
	return err
}

func (s *store) saveMonitoringKey(ctx context.Context, roomID string, wrapped []byte) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO room_monitor_keys(room_id,wrapped_key) VALUES(?,?)
ON CONFLICT(room_id) DO UPDATE SET wrapped_key=excluded.wrapped_key`, roomID, wrapped)
	return err
}

func (s *store) load(ctx context.Context) (map[string]*Room, map[string]*Member, error) {
	rooms := map[string]*Room{}
	members := map[string]*Member{}
	rows, err := s.db.QueryContext(ctx, `SELECT id,name,host_member_id,host_nickname,max_participants,host_timeout_minutes,created_at,host_reconnect_deadline,empty_deadline FROM rooms`)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		room := &Room{}
		var created int64
		var hostDeadline, emptyDeadline sql.NullInt64
		if err := rows.Scan(&room.ID, &room.Name, &room.HostMemberID, &room.HostNickname, &room.MaxParticipants, &room.HostDisconnectTimeoutMinutes, &created, &hostDeadline, &emptyDeadline); err != nil {
			rows.Close()
			return nil, nil, err
		}
		room.CreatedAt = time.UnixMilli(created).UTC()
		room.HostReconnectDeadline = timestamp(hostDeadline)
		room.EmptyDeadline = timestamp(emptyDeadline)
		rooms[room.ID] = room
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}
	keyRows, err := s.db.QueryContext(ctx, `SELECT room_id,wrapped_key FROM room_monitor_keys`)
	if err != nil {
		return nil, nil, err
	}
	for keyRows.Next() {
		var roomID string
		var wrapped []byte
		if err := keyRows.Scan(&roomID, &wrapped); err != nil {
			keyRows.Close()
			return nil, nil, err
		}
		if room := rooms[roomID]; room != nil {
			room.MonitoringKey = append([]byte(nil), wrapped...)
		}
	}
	if err := keyRows.Close(); err != nil {
		return nil, nil, err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT id,room_id,nickname,device_id,resume_token_hash,can_speak,join_order,reconnect_deadline FROM members`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		member := &Member{}
		var deadline sql.NullInt64
		if err := rows.Scan(&member.ID, &member.RoomID, &member.Nickname, &member.DeviceID, &member.ResumeTokenHash, &member.CanSpeak, &member.JoinOrder, &deadline); err != nil {
			return nil, nil, err
		}
		member.ReconnectDeadline = timestamp(deadline)
		member.IsHost = rooms[member.RoomID] != nil && rooms[member.RoomID].HostMemberID == member.ID
		members[member.ID] = member
	}
	return rooms, members, rows.Err()
}

func (s *store) deleteMember(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM members WHERE id=?", id)
	return err
}
func (s *store) deleteRoom(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM rooms WHERE id=?", id)
	return err
}
func (s *store) close() error { return s.db.Close() }
