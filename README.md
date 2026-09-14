# DawnMesh Server

Self-hosted control plane and LiveKit media service for the public-internet mode of DawnMesh (曙光之声). It keeps room metadata in SQLite, relays the client-to-client SPAKE2 admission exchange, enforces host moderation, and issues short-lived, least-privilege LiveKit tokens. Voice and chat content use client-side LiveKit E2EE keys that this service never receives.

This repository does not request or renew HTTPS certificates. Use your existing Nginx for TLS termination and reverse proxying.

## Requirements

- Linux server with Docker Engine and Docker Compose
- Public domain names for the DawnMesh API and LiveKit signalling
- Publicly reachable UDP 7882 and TCP 7881, or equivalent Layer 4 forwarding
- Existing Nginx HTTPS configuration

## Deploy

```bash
cp config.example.env .env
cp livekit.example.yaml livekit.yaml
# Or generate random instance/access/LiveKit credentials first:
./scripts/init-config.sh
```

Edit `.env` and `livekit.yaml`. The LiveKit API key and secret must match. Set `DAWNMESH_PUBLIC_URL` to the HTTPS API origin and `LIVEKIT_PUBLIC_URL` to the public `wss://` LiveKit signalling origin.

```bash
docker compose up -d --build
curl -fsS https://talk.example.com/healthz
```

Copy the relevant parts of `deploy/nginx.example.conf` into the Nginx sites you already manage. `/api/` must support WebSocket upgrades because admission and room-management events use that endpoint. Map UDP 7882 and TCP 7881 directly when possible. A successful HTTPS health check only verifies the control plane, not the WebRTC media path.

In the Android app, add `DAWNMESH_PUBLIC_URL` as a network-intercom server and enter `DAWNMESH_ACCESS_TOKEN` as its access credential.

The management protocol is documented in [`docs/API.md`](docs/API.md). `DAWNMESH_MAX_ROOMS` limits retained rooms for one process; creation and admission requests also have built-in source, device, room, and global bounds.

## TURN

UDP is preferred for live speech. ICE/TCP 7881 is the fallback. To support networks that block both, enable LiveKit's authenticated TURN service. TURN/TLS is a Layer 4 protocol and cannot be placed in an Nginx HTTP `location`. It can use a dedicated public port/IP, or an outer Nginx `stream` SNI split after verifying client SNI behavior. When Nginx terminates TURN TLS, set `turn.external_tls: true` in LiveKit.

## State and recovery

- Ordinary unexpected disconnects retain identity for 10 minutes.
- A host chooses 1–60 minutes at room creation; 10 minutes is the default.
- If the host deadline expires while other members remain online, ownership moves to the earliest online member.
- An entirely empty room is removed 10 minutes after the last disconnect, even if the host selected a longer timeout.
- Explicit host room termination is immediate.

SQLite files live in the `dawnmesh-data` volume. Back up the database together with `.env` and `livekit.yaml`. Invite codes, E2EE room keys, and chat content are not stored in SQLite.

## Security notes

New LiveKit join tokens start with audio publication disabled. After the authenticated management channel is established, the service applies the current persisted voice policy to the connected participant. Replaying an old token therefore cannot restore a revoked microphone permission. Tokens expire after two minutes and API secrets remain server-side.

The six-digit invite never enters an HTTP request, room metadata, JWT, or server log. The online host performs SPAKE2 and wraps an independent random E2EE room key for the joining client. Keep `DAWNMESH_ACCESS_TOKEN` high entropy because a six-digit human code is not suitable as an internet-wide access-control secret by itself.

## Development

```bash
go test ./...
go vet ./...
```

The server API protocol is versioned as `v1`. The Android client rejects incompatible protocol versions and detects unexpected instance-ID changes.

## License

Apache License 2.0. See `LICENSE`.
