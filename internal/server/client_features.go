package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
)

// Read on each info request: an atomic file replacement applies to clients on
// their next poll, without a process restart. Unknown client capabilities are
// not executable code and older clients ignore this optional manifest.
type clientFeatures struct {
	SchemaVersion       int    `json:"schemaVersion"`
	HybridAudio         bool   `json:"hybridAudio"`
	HybridMaxPeers      int    `json:"hybridMaxPeers"`
	HybridMaxRttMs      int    `json:"hybridMaxRttMs"`
	HybridStableSamples int    `json:"hybridStableSamples"`
	Notice              string `json:"notice"`
}

func (s *Server) clientFeatures() clientFeatures {
	f := clientFeatures{SchemaVersion: 1, HybridAudio: true, HybridMaxPeers: 4, HybridMaxRttMs: 120, HybridStableSamples: 3}
	path := s.cfg.ClientFeaturesPath
	if path == "" {
		return f
	}
	file, err := os.Open(path)
	if err != nil {
		f.HybridAudio = false
		return f
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 8193))
	var custom clientFeatures
	if decoder.Decode(&custom) != nil || custom.SchemaVersion != 1 || custom.HybridMaxPeers < 1 || custom.HybridMaxPeers > 4 || custom.HybridMaxRttMs < 40 || custom.HybridMaxRttMs > 300 || custom.HybridStableSamples < 3 || custom.HybridStableSamples > 10 || len(custom.Notice) > 600 {
		f.HybridAudio = false
		return f
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		f.HybridAudio = false
		return f
	}
	return custom
}
func (s *Server) featureInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	s.info(w, r)
}
