package server

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func TestMonitoringKeyIsWrappedAndBoundToAdminCredentialAndRoom(t *testing.T) {
	encoded := base64.URLEncoding.EncodeToString(bytes.Repeat([]byte{0x5a}, 32))
	wrapped, err := wrapMonitoringKey(testAdminToken, "room-a", encoded)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(wrapped, []byte(encoded)) {
		t.Fatal("wrapped key contains plaintext material")
	}
	plain, err := unwrapMonitoringKey(testAdminToken, "room-a", wrapped)
	if err != nil || plain != encoded {
		t.Fatalf("unwrap=(%q, %v), want original", plain, err)
	}
	if _, err := unwrapMonitoringKey("different-admin-token-that-is-long-enough", "room-a", wrapped); err == nil {
		t.Fatal("different administrator credential decrypted monitoring key")
	}
	if _, err := unwrapMonitoringKey(testAdminToken, "room-b", wrapped); err == nil {
		t.Fatal("wrapped key was not bound to its room")
	}
}
