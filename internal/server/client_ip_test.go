package server

import (
	"github.com/TimeLordFang/DawnMeshServer/internal/config"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestClientIPTrustBoundary(t *testing.T) {
	s := &Server{cfg: config.Config{TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("::1/128"), netip.MustParsePrefix("172.18.0.1/32")}}}
	for _, tt := range []struct{ name, remote, xff, want string }{
		{"untrusted direct", "203.0.113.9:123", "198.51.100.7", "203.0.113.9"},
		{"spoofed prefix", "127.0.0.1:123", "198.51.100.7, 203.0.113.9", "203.0.113.9"},
		{"container gateway", "172.18.0.1:123", "203.0.113.9", "203.0.113.9"},
		{"untrusted private IP", "172.18.0.2:123", "203.0.113.9", "172.18.0.2"},
		{"trusted chain", "127.0.0.1:123", "198.51.100.7, 203.0.113.9, 172.18.0.1", "203.0.113.9"},
		{"IPv6", "[::1]:123", "2001:db8::7", "2001:db8::7"},
		{"mapped IPv4", "[::ffff:127.0.0.1]:123", "::ffff:203.0.113.9", "203.0.113.9"},
		{"invalid nearest hop", "127.0.0.1:123", "203.0.113.9, bad", "127.0.0.1"},
		{"no header", "127.0.0.1:123", "", "127.0.0.1"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = tt.remote
			r.Header.Set("X-Forwarded-For", tt.xff)
			if got := s.clientIP(r); got != tt.want {
				t.Fatalf("got %s want %s", got, tt.want)
			}
		})
	}
	s.cfg.TrustedProxyCIDRs = nil
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:123"
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got := s.clientIP(r); got != "127.0.0.1" {
		t.Fatal(got)
	}
}
func TestProxyClientsHaveIndependentBuckets(t *testing.T) {
	s := testServer(t)
	s.cfg.TrustedProxyCIDRs = []netip.Prefix{netip.MustParsePrefix("172.18.0.1/32")}
	for _, ip := range []string{"203.0.113.8", "203.0.113.9"} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "172.18.0.1:123"
		r.Header.Set("X-Forwarded-For", ip)
		s.mu.Lock()
		for i := 0; i < 20; i++ {
			if !s.allowAttemptLocked("join:ip:"+s.clientIP(r), 20, 60000000000) {
				t.Error("clients share bucket")
			}
		}
		if s.allowAttemptLocked("join:ip:"+s.clientIP(r), 20, 60000000000) {
			t.Error("limit not enforced")
		}
		s.mu.Unlock()
	}
}
