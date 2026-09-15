# DawnMesh Server

[简体中文](README.md) · [Releases](https://github.com/TimeLordFang/DawnMeshServer/releases) · [Container image](https://github.com/TimeLordFang/DawnMeshServer/pkgs/container/dawnmeshserver)

[![CI](https://github.com/TimeLordFang/DawnMeshServer/actions/workflows/ci.yml/badge.svg)](https://github.com/TimeLordFang/DawnMeshServer/actions/workflows/ci.yml)
[![Release](https://github.com/TimeLordFang/DawnMeshServer/actions/workflows/release.yml/badge.svg)](https://github.com/TimeLordFang/DawnMeshServer/actions/workflows/release.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

DawnMesh Server is the self-hosted control plane for DawnMesh public intercom rooms. It stores room metadata in SQLite, relays the client-to-client SPAKE2 admission exchange, enforces host moderation, and issues short-lived, least-privilege LiveKit tokens. Voice and chat use client-held LiveKit E2EE keys by default. A host can explicitly allow the self-hosted server administrator to listen when creating a room.

The project does not request or renew HTTPS certificates. Put the API and LiveKit signalling behind an existing Nginx TLS endpoint.

## Features

- 25 participants per room by default, configurable through `DAWNMESH_MAX_PARTICIPANTS`
- Six-digit invitations verified with SPAKE2 and excluded from HTTP requests, metadata, JWTs, and server logs
- Host controls for room names, participant microphones, and explicit room termination
- Configurable 1–60 minute host disconnect deadline
- Automatic host transfer and cleanup of empty rooms
- Persistent control state in SQLite, with media handled by LiveKit
- Embedded single-binary `/client/` web intercom and `/admin/` administration console
- Host-authorized live listening through an E2EE, subscribe-only administrator connection, with a visible in-room indicator

## Requirements

- Linux `amd64` or `arm64`
- Docker Engine and Docker Compose, or Go 1.27.1+
- Public domains for the DawnMesh API and LiveKit signalling
- Public UDP 57882 and TCP 57881, or equivalent Layer 4 forwarding
- An existing Nginx HTTPS entry point

## Deploy the container image

Clone the repository and create the local configuration:

```bash
cp config.example.env .env
cp livekit.example.yaml livekit.yaml
# Or generate random instance, access, and LiveKit credentials:
./scripts/init-config.sh
```

Edit `.env` and `livekit.yaml`. Their LiveKit API key and secret must match. Set `DAWNMESH_PUBLIC_URL` to the public HTTPS API origin and `LIVEKIT_PUBLIC_URL` to the public `wss://` signalling origin. LiveKit uses host networking. Compose maps the `livekit` hostname inside the DawnMesh Server container to the host gateway, so the existing `LIVEKIT_URL=http://livekit:7880` remains valid.

```bash
docker compose pull
docker compose up -d --no-build
curl -fsS https://talk.example.com/healthz
```

The default image is `ghcr.io/timelordfang/dawnmeshserver:latest`. Pin a version through `.env` when required:

```dotenv
DAWNMESH_IMAGE=ghcr.io/timelordfang/dawnmeshserver:1.0.0
```

After the first publication, change the container package visibility to **Public** in GitHub Package settings so anonymous users can pull it. This is a one-time GHCR package setting.

Build locally from source with:

```bash
docker compose up -d --build
```

Merge the relevant parts of [`deploy/nginx.example.conf`](deploy/nginx.example.conf) into your Nginx configuration. `/api/` must allow WebSocket upgrades. Forward UDP 57882 and TCP 57881 directly when possible. A successful HTTPS health check verifies the control plane only, not the WebRTC media path.

Add `DAWNMESH_PUBLIC_URL` in the Android app's network intercom settings and use `DAWNMESH_ACCESS_TOKEN` as the server credential.

## Web intercom client

After deployment, open `https://talk.example.com/client/`. The web client uses the server that served the page. Enter `DAWNMESH_ACCESS_TOKEN` on the initial screen when the deployment requires it.

The browser and Android public-room clients share the same protocol and rooms. The web client can create and discover rooms, join with a six-digit invite, use push-to-talk or automatic voice, switch among clarity/balanced/data-saver profiles, exchange encrypted text messages, and show speaking state with stable member avatars. Hosts can rename or end the room, control another member's microphone permission, and transfer ownership. A short network interruption is recovered within the existing ten-minute member retention window.

Invite authentication uses the same scrypt and P-256 SPAKE2 transcript as Android, and the invite never reaches the server. LiveKit media uses the same E2EE room key; chat uses a purpose-separated AES-256-GCM key.

Microphone capture and Web Crypto require an HTTPS secure context (`localhost` is allowed for development). Browser support for WebRTC E2EE, background audio, and output-device selection varies. A mobile browser may suspend or terminate a page after screen lock, so the Android app remains the recommended client for long-running background intercom use. WebSocket credentials are carried in the `Sec-WebSocket-Protocol` request header; configure Nginx and other reverse proxies not to log that header.

The access credential is kept in tab-scoped `sessionStorage`; the nickname and random device identifier are stored in `localStorage`. The invite, room key, and rotating resume token remain in page memory and are discarded on refresh or close.

## Admin console

Open `https://talk.example.com/admin/` and enter `DAWNMESH_ADMIN_TOKEN` from `.env`. The initialization script generates this separate administrator credential automatically. It must contain at least 32 characters and must differ from the client-facing `DAWNMESH_ACCESS_TOKEN`.

The static console is compiled into the `dawnmesh-server` binary with Go `embed`; it needs no Node.js runtime, static directory, or separate web service. It can:

- Show uptime, rooms, online members, and retained members
- Show hosts, connection and recovery states, and pending admissions
- Rename rooms
- Disable or restore microphone permission for non-host members
- End rooms immediately
- Listen live to rooms whose hosts explicitly enabled administrator listening
- Refresh automatically every 10 seconds or on demand

The admin credential is kept in the current tab's `sessionStorage` and sent only through the `Authorization: Bearer` header. It does not enter the URL or cookies. Admin APIs remain disabled when `DAWNMESH_ADMIN_TOKEN` is unset. Expose the console over HTTPS only and consider an Nginx IP allowlist or additional authentication where appropriate.

Live listening is disabled by default. Only an opted-in host sends the room E2EE key to the server. The server encrypts it in SQLite with AES-GCM using a key derived from `DAWNMESH_ADMIN_TOKEN`. A listener receives a hidden, subscribe-only, non-publishing LiveKit grant and renews a short lease every 10 seconds; abandoned sessions expire in about 35 seconds. Every room participant sees the active listening state. Rotating the administrator token invalidates escrowed keys for existing rooms.

## Deploy a release binary

Every `v*` tag publishes Linux `amd64` and `arm64` archives plus `SHA256SUMS` on [GitHub Releases](https://github.com/TimeLordFang/DawnMeshServer/releases):

```bash
sha256sum -c SHA256SUMS
install -m 0755 dawnmesh-server /usr/local/bin/dawnmesh-server
```

The process needs the environment variables described in `config.example.env` and write access to the parent directory of `DAWNMESH_DATABASE`. LiveKit remains a separate service.

## TURN and network ports

The LiveKit container uses host networking and listens on the host's IPv4 and IPv6 wildcard addresses. UDP 57882 is preferred for real-time voice, with ICE/TCP 57881 as fallback; allow both address families through the host firewall and cloud security group. `use_external_ip: true` discovers one public address. To advertise fixed public IPv4 and IPv6 addresses together, set `use_external_ip: false` and `node_ip: "public-IPv4,public-IPv6"`.

LiveKit's authenticated TURN service can support networks that block both UDP and ICE/TCP. TURN/TLS is a Layer 4 protocol and cannot use an Nginx HTTP `location`. Give it a dedicated public port/IP, or use Nginx `stream` SNI routing after checking client SNI behavior. Set `turn.external_tls: true` when Nginx terminates TURN TLS.

## Recovery behavior

- An ordinary member retains their identity for 10 minutes after an unexpected disconnect.
- A host chooses a 1–60 minute deadline when creating the room; the default is 10 minutes.
- If the host deadline expires while members remain online, ownership moves to the earliest online member.
- An entirely empty room is removed 10 minutes after the final disconnect, even when the host selected a longer deadline.
- Explicit host termination removes the room immediately.

SQLite data lives in the `dawnmesh-data` volume. Back up the database together with `.env` and `livekit.yaml`. Invite codes and chat content are not written to SQLite. The server stores an E2EE room key wrapped by the administrator credential only when the host explicitly enables administrator listening.

## Security

New LiveKit join tokens start with audio publication disabled. After an authenticated management channel is established, the server applies the current persisted voice policy to the participant. Replaying an old token cannot restore revoked microphone access. Tokens expire after two minutes and API secrets stay server-side.

A six-digit invitation is not strong enough to protect a public service by itself. Generate a high-entropy `DAWNMESH_ACCESS_TOKEN`. `DAWNMESH_ADMIN_TOKEN` also protects host-authorized listening keys, so keep it away from ordinary App users, restrict database and configuration permissions, and keep images updated.

The management protocol is documented in [`docs/API.md`](docs/API.md). It is versioned as `v1`; the Android client rejects incompatible versions and detects unexpected instance-ID changes.

## Development

```bash
go test -race ./...
go vet ./...
go install golang.org/x/vuln/cmd/govulncheck@v1.8.0
govulncheck ./...
```

Pushes to `main` and pull requests run module consistency checks, race-enabled tests, `go vet`, vulnerability scanning, and Linux cross-builds. A `v*` tag publishes release archives, checksums, and a multi-architecture GHCR image. Dependabot checks Go modules, Docker images, and GitHub Actions weekly.

```bash
git tag -a v0.1.0 -m "DawnMesh Server v0.1.0"
git push origin v0.1.0
```

## License

DawnMesh Server is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). If you modify this project and make it available to users over a network, the AGPL requires you to offer those users the corresponding source. LiveKit and other dependencies remain under their respective licenses.
