package config

import (
	"strings"
	"testing"
)

func TestAdminTokenValidation(t *testing.T) {
	tests := []struct {
		name       string
		adminToken string
		wantError  string
	}{
		{name: "disabled", adminToken: ""},
		{name: "separate credential", adminToken: "admin-token-that-is-at-least-thirty-two-characters"},
		{name: "too short", adminToken: "short", wantError: "at least 32"},
		{name: "same as client token", adminToken: "client-token-that-is-at-least-thirty-two-characters", wantError: "must differ"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			setValidEnvironment(t)
			t.Setenv("DAWNMESH_ADMIN_TOKEN", test.adminToken)
			_, err := Load()
			if test.wantError == "" {
				if err != nil {
					t.Fatalf("Load() returned unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Load() error = %v, want error containing %q", err, test.wantError)
			}
		})
	}
}

func setValidEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("DAWNMESH_LISTEN", ":8080")
	t.Setenv("DAWNMESH_DATABASE", t.TempDir()+"/dawnmesh.db")
	t.Setenv("DAWNMESH_INSTANCE_ID", "test-instance")
	t.Setenv("DAWNMESH_INSTANCE_NAME", "DawnMesh Test")
	t.Setenv("DAWNMESH_PUBLIC_URL", "https://talk.example.test")
	t.Setenv("LIVEKIT_URL", "http://127.0.0.1:7880")
	t.Setenv("LIVEKIT_PUBLIC_URL", "wss://rtc.example.test")
	t.Setenv("LIVEKIT_API_KEY", "test-key")
	t.Setenv("LIVEKIT_API_SECRET", "livekit-secret-that-is-at-least-thirty-two-characters")
	t.Setenv("DAWNMESH_ACCESS_TOKEN", "client-token-that-is-at-least-thirty-two-characters")
	t.Setenv("DAWNMESH_MAX_PARTICIPANTS", "100")
	t.Setenv("DAWNMESH_MAX_ROOMS", "1000")
}
