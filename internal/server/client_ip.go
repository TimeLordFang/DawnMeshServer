package server

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

func (s *Server) trustedProxy(ip netip.Addr) bool {
	for _, prefix := range s.cfg.TrustedProxyCIDRs {
		if prefix.Contains(ip.Unmap()) {
			return true
		}
	}
	return false
}

func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remote, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	remote = remote.Unmap()
	if !s.trustedProxy(remote) {
		return remote.String()
	}
	// Walk from our peer toward the client. A caller cannot claim arbitrary
	// addresses to the left of the first untrusted hop.
	chain := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	current := remote
	for i := len(chain) - 1; i >= 0; i-- {
		if !s.trustedProxy(current) {
			return current.String()
		}
		next, err := netip.ParseAddr(strings.TrimSpace(chain[i]))
		if err != nil || next.Zone() != "" {
			return remote.String()
		}
		current = next.Unmap()
	}
	return current.String()
}
