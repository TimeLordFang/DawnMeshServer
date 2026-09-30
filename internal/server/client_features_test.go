package server

import (
	"os"
	"testing"
)

func TestFeaturesReloadWithoutRestartAndFailClosed(t *testing.T) {
	s := testServer(t)
	if f := s.clientFeatures(); !f.HybridAudio || f.HybridMaxLossPercent != 3 || f.HybridMaxJitterMs != 40 {
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
	if f := s.clientFeatures(); !f.HybridAudio || f.HybridMaxPeers != 2 || f.Notice != "test" || f.HybridMaxLossPercent != 3 || f.HybridMaxJitterMs != 40 {
		t.Fatal(f)
	}
	write(`{"schemaVersion":1,"hybridAudio":true,"hybridMaxPeers":4,"hybridMaxRttMs":120,"hybridStableSamples":3,"hybridMaxLossPercent":0,"hybridMaxJitterMs":80}`)
	if f := s.clientFeatures(); !f.HybridAudio || f.HybridMaxLossPercent != 0 || f.HybridMaxJitterMs != 80 {
		t.Fatal("hot thresholds ignored", f)
	}
	for _, thresholds := range []string{`"hybridMaxLossPercent":21`, `"hybridMaxLossPercent":-1`, `"hybridMaxJitterMs":201`, `"hybridMaxJitterMs":0`} {
		write(`{"schemaVersion":1,"hybridAudio":true,"hybridMaxPeers":4,"hybridMaxRttMs":120,"hybridStableSamples":3,` + thresholds + `}`)
		if s.clientFeatures().HybridAudio {
			t.Fatal("invalid threshold enabled feature", thresholds)
		}
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
