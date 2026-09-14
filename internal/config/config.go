package config

import (
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	ListenAddress       string
	DatabasePath        string
	InstanceID          string
	InstanceName        string
	PublicBaseURL       string
	LiveKitURL          string
	LiveKitPublicURL    string
	LiveKitAPIKey       string
	LiveKitAPISecret    string
	AccessToken         string
	AdminToken          string
	MaximumParticipants int
	MaximumRooms        int
}

func Load() (Config, error) {
	maximum, err := strconv.Atoi(value("DAWNMESH_MAX_PARTICIPANTS", "100"))
	if err != nil || maximum < 2 || maximum > 500 {
		return Config{}, errors.New("DAWNMESH_MAX_PARTICIPANTS must be between 2 and 500")
	}
	maximumRooms, err := strconv.Atoi(value("DAWNMESH_MAX_ROOMS", "1000"))
	if err != nil || maximumRooms < 1 || maximumRooms > 100000 {
		return Config{}, errors.New("DAWNMESH_MAX_ROOMS must be between 1 and 100000")
	}
	cfg := Config{
		ListenAddress:       value("DAWNMESH_LISTEN", ":8080"),
		DatabasePath:        value("DAWNMESH_DATABASE", "/data/dawnmesh.db"),
		InstanceID:          strings.TrimSpace(os.Getenv("DAWNMESH_INSTANCE_ID")),
		InstanceName:        value("DAWNMESH_INSTANCE_NAME", "DawnMesh Server"),
		PublicBaseURL:       strings.TrimRight(strings.TrimSpace(os.Getenv("DAWNMESH_PUBLIC_URL")), "/"),
		LiveKitURL:          strings.TrimRight(strings.TrimSpace(os.Getenv("LIVEKIT_URL")), "/"),
		LiveKitPublicURL:    strings.TrimRight(strings.TrimSpace(os.Getenv("LIVEKIT_PUBLIC_URL")), "/"),
		LiveKitAPIKey:       strings.TrimSpace(os.Getenv("LIVEKIT_API_KEY")),
		LiveKitAPISecret:    strings.TrimSpace(os.Getenv("LIVEKIT_API_SECRET")),
		AccessToken:         strings.TrimSpace(os.Getenv("DAWNMESH_ACCESS_TOKEN")),
		AdminToken:          strings.TrimSpace(os.Getenv("DAWNMESH_ADMIN_TOKEN")),
		MaximumParticipants: maximum,
		MaximumRooms:        maximumRooms,
	}
	if cfg.InstanceID == "" || cfg.PublicBaseURL == "" || cfg.LiveKitURL == "" || cfg.LiveKitPublicURL == "" || cfg.LiveKitAPIKey == "" || len(cfg.LiveKitAPISecret) < 32 {
		return Config{}, errors.New("instance id, public URLs, LiveKit key, and a 32+ character LiveKit secret are required")
	}
	if cfg.AdminToken != "" && len(cfg.AdminToken) < 32 {
		return Config{}, errors.New("DAWNMESH_ADMIN_TOKEN must contain at least 32 characters")
	}
	if cfg.AdminToken != "" && cfg.AdminToken == cfg.AccessToken {
		return Config{}, errors.New("DAWNMESH_ADMIN_TOKEN must differ from DAWNMESH_ACCESS_TOKEN")
	}
	publicURL, publicErr := url.Parse(cfg.PublicBaseURL)
	liveKitPublicURL, liveKitPublicErr := url.Parse(cfg.LiveKitPublicURL)
	if publicErr != nil || publicURL.Scheme != "https" || publicURL.Host == "" || publicURL.User != nil || publicURL.RawQuery != "" || publicURL.Fragment != "" || liveKitPublicErr != nil || liveKitPublicURL.Scheme != "wss" || liveKitPublicURL.Host == "" {
		return Config{}, errors.New("DAWNMESH_PUBLIC_URL must be HTTPS and LIVEKIT_PUBLIC_URL must be WSS")
	}
	return cfg, nil
}

func value(name, fallback string) string {
	if result := strings.TrimSpace(os.Getenv(name)); result != "" {
		return result
	}
	return fallback
}
