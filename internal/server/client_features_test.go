package server

import (
	"os"
	"testing"
)

func TestFeaturesReloadWithoutRestartAndFailClosed(t *testing.T) {
	s := testServer(t)
	if !s.clientFeatures().HybridAudio {
		t.Fatal("missing default capability")
	}
	path := t.TempDir() + "/features.json"
	s.cfg.ClientFeaturesPath = path
	write := func(raw string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"schemaVersion":1,"hybridAudio":true,"hybridMaxPeers":2,"hybridMaxRttMs":80,"hybridStableSamples":5,"notice":"test"}`)
	if f := s.clientFeatures(); !f.HybridAudio || f.HybridMaxPeers != 2 || f.Notice != "test" {
		t.Fatal(f)
	}
	write(`{"schemaVersion":1,"hybridAudio":false,"hybridMaxPeers":2,"hybridMaxRttMs":80,"hybridStableSamples":5}`)
	if s.clientFeatures().HybridAudio {
		t.Fatal("hot disable ignored")
	}
	for _, raw := range []string{`{`, `{"schemaVersion":99}`, `{"schemaVersion":1,"hybridAudio":true,"hybridMaxPeers":500}`, `{} {}`} {
		write(raw)
		if s.clientFeatures().HybridAudio {
			t.Fatal("invalid manifest enabled native feature")
		}
	}
}
