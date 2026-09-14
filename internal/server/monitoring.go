package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"time"
)

const (
	monitorSessionTTL        = 35 * time.Second
	maxAdminListenersPerRoom = 4
)

type monitorSession struct {
	ID        string
	RoomID    string
	ExpiresAt time.Time
}

func wrapMonitoringKey(adminToken, roomID, encoded string) ([]byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(trimBase64Padding(encoded))
	if err != nil || len(raw) != 32 {
		return nil, errors.New("monitoring key must contain 32 bytes")
	}
	aead, err := monitoringAEAD(adminToken)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(encoded), []byte(roomID)), nil
}

func unwrapMonitoringKey(adminToken, roomID string, wrapped []byte) (string, error) {
	aead, err := monitoringAEAD(adminToken)
	if err != nil {
		return "", err
	}
	if len(wrapped) < aead.NonceSize() {
		return "", errors.New("monitoring key is truncated")
	}
	nonce := wrapped[:aead.NonceSize()]
	plain, err := aead.Open(nil, nonce, wrapped[aead.NonceSize():], []byte(roomID))
	if err != nil {
		return "", errors.New("monitoring key cannot be decrypted")
	}
	return string(plain), nil
}

func monitoringAEAD(adminToken string) (cipher.AEAD, error) {
	if adminToken == "" {
		return nil, errors.New("administrator credential is not configured")
	}
	seed := sha256.Sum256([]byte("DawnMesh admin monitoring key v1\x00" + adminToken))
	block, err := aes.NewCipher(seed[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func trimBase64Padding(value string) string {
	for len(value) > 0 && value[len(value)-1] == '=' {
		value = value[:len(value)-1]
	}
	return value
}
