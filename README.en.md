<p align="center">
  <img src="docs/assets/dawnmesh-logo.png" width="144" height="144" alt="DawnMesh app logo">
</p>

# DawnMesh Server & Web

**Beyond the horizon, let voices meet.**

[Android](https://github.com/TimeLordFang/DawnMesh) · [iOS](https://github.com/TimeLordFang/DawnMeshIOS) · [Server & Web](https://github.com/TimeLordFang/DawnMeshServer)

[中文](README.md) · [Downloads and release history](https://github.com/TimeLordFang/DawnMeshServer/releases) · [Container images](https://github.com/TimeLordFang/DawnMeshServer/pkgs/container/dawnmeshserver)

DawnMesh is a voice intercom for nearby offline groups and self-hosted remote rooms. This repository provides its control server, browser intercom and administration console. Android and iOS clients communicate locally without a public service, or use a shared server to reach remote participants.

## Repositories

| Repository | Role |
| --- | --- |
| [Android](https://github.com/TimeLordFang/DawnMesh) | Android mobile client for local and remote rooms. |
| [iOS](https://github.com/TimeLordFang/DawnMeshIOS) | iPhone client using compatible room and encryption protocols. |
| [Server & Web](https://github.com/TimeLordFang/DawnMeshServer) | Room control, fusion directory and encrypted relay, browser client and admin console. |

## Room modes and deployment dependencies

| Mode | Deployment required | How it connects |
| --- | --- | --- |
| Nearby Wi-Fi / Bluetooth | None | Phones communicate over a local link without Internet access. Protocol limits are 16 Wi-Fi or 6 Bluetooth members. |
| Local offline fusion | None | Create, join and talk over a shared Wi-Fi, hotspot or supported local peer link. |
| Fusion across networks | DawnMesh Server | Admitted online members publish signed directory state and relay ciphertext through the same server. Remote access needs a reachable gateway; the host need not connect to the server directly. |
| Internet rooms | DawnMesh Server and LiveKit | The server controls rooms and admission; LiveKit carries real-time media. Clients must reach both services and the media ports. |

The mobile apps do not include a public server. Deploy an instance, then add its HTTPS URL and, when configured, its access credential in **Settings → Servers** on Android or iOS and select the same instance on participating phones. Fusion relay forwards encrypted nearby-room frames over WebSocket, rather than the LiveKit media path. The default Compose deployment includes both services to support both room types. Losing the Internet path does not end established local fusion communication.

The browser client joins Internet rooms, not mobile nearby or fusion rooms. Apple peer Wi-Fi and Android Wi-Fi Direct are separate radio transports; mixed local groups can use shared Wi-Fi/hotspots or supported Bluetooth paths. Device capacity and background behavior require real-device acceptance.

This project does not issue or renew TLS certificates. Put the API and LiveKit signaling behind your existing HTTPS/WSS reverse proxy; follow the deployment and port instructions below. See the [documentation index](docs/README.md) for API and fusion details.

## Known issue

**Bluetooth-room communication may become severely intermittent while a Bluetooth headset is connected at the same time.** In current testing, Bluetooth-room communication works normally without a Bluetooth headset. This observation does not guarantee the same result across every phone, headset and operating-system combination.

If audio is intermittent, disconnect the headset and compare using the phone audio, recording the phone, headset and OS versions. This is a mobile Bluetooth-room scenario; it does not by itself indicate a problem with the Internet-room server.

## Features

- 25 participants per room by default, configurable through `DAWNMESH_MAX_PARTICIPANTS`
- Four-digit invitations derive separate admission and key-wrapping secrets; the server admits members even while the host is offline
- Host controls for room names, participant microphones, and explicit room termination
- Configurable 1–60 minute host disconnect deadline
- Automatic host transfer and cleanup of empty rooms
- Persistent control state in SQLite, with media handled by LiveKit
- Embedded single-binary `/client/` web intercom and `/admin/` administration console
- Host-authorized live listening through an E2EE, subscribe-only administrator connection, with a visible in-room indicator

## Requirements

- Linux `amd64` or `arm64`
- Docker Engine and Docker Compose, or the Go toolchain specified by `go.mod`
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
curl -fsS -H 'Authorization: Bearer <DAWNMESH_ACCESS_TOKEN>' https://talk.example.com/api/v1/media-health
```

`/healthz` only checks the DawnMesh Server process. `/api/v1/media-health` also calls the LiveKit control API with the configured API key and secret. A `503` response points to the LiveKit process, `LIVEKIT_URL`, or mismatched credentials between `.env` and `livekit.yaml`. If it returns `200` while the browser still reports a media failure, check the public path: `LIVEKIT_PUBLIC_URL` must reach the LiveKit WSS endpoint on `127.0.0.1:7880`, and the host and cloud firewalls must allow UDP 57882 and TCP 57881. The web client now keeps the latest detailed diagnosis visible instead of replacing it with a generic media-disconnected message.

The default image is `ghcr.io/timelordfang/dawnmeshserver:latest`. Pin a version through `.env` when required:

```dotenv
DAWNMESH_IMAGE=ghcr.io/timelordfang/dawnmeshserver:<chosen-release-tag>
```

After the first publication, change the container package visibility to **Public** in GitHub Package settings so anonymous users can pull it. This is a one-time GHCR package setting.

Build locally from source with:

```bash
docker compose up -d --build
```

Merge the relevant parts of [`deploy/nginx.example.conf`](deploy/nginx.example.conf) into your Nginx configuration. `/api/` should allow WebSocket upgrades and must preserve the original `Host`, `Origin`, and `Sec-WebSocket-Protocol` headers. The last header carries the browser management channel credentials. The server sends a WebSocket heartbeat every 20 seconds; when an upgrade still fails, the web client automatically uses an authenticated HTTPS event stream. An Nginx `401` usually means credential headers were not forwarded, while `403` usually means `Host` and `Origin` did not match. Forward UDP 57882 and TCP 57881 directly when possible. A successful HTTPS health check verifies the control plane only, not the WebRTC media path.

Add `DAWNMESH_PUBLIC_URL` in **Settings → Servers** on Android or iOS and provide `DAWNMESH_ACCESS_TOKEN` when the instance requires it.

## Web intercom client

After deployment, open `https://talk.example.com/client/`. The web client uses the server that served the page. Enter `DAWNMESH_ACCESS_TOKEN` on the initial screen when the deployment requires it.

The browser and Android public-room clients share the same protocol and rooms. The web client can create and discover rooms, join with a four-digit invite, use push-to-talk or automatic voice, switch among clarity/balanced/data-saver profiles, exchange encrypted text messages, and show speaking state with stable member avatars. Listening and microphone capture are enabled separately, so a computer without an input device can still receive room audio. Hosts can rename or end the room, control another member's microphone permission, and transfer ownership. The management channel prefers WebSocket and automatically falls back to an authenticated HTTPS stream when a proxy rejects the upgrade. Media recovery independently refreshes its short-lived grant within the existing thirty-minute member retention window.

Invite authentication uses a per-room random salt and scrypt-derived admission credential, verified directly by the server. The raw invite is not transmitted. LiveKit media uses the same E2EE room key; chat uses a purpose-separated AES-256-GCM key.

Microphone capture and Web Crypto require an HTTPS secure context (`localhost` is allowed for development). Browser support for WebRTC E2EE, background audio, and output-device selection varies. A mobile browser may suspend or terminate a page after screen lock, so use a native mobile client for sustained intercom sessions and verify its background behavior on the actual device. WebSocket credentials are carried in the `Sec-WebSocket-Protocol` request header; configure Nginx and other reverse proxies not to log that header.

The access credential is kept in tab-scoped `sessionStorage`; the nickname and random device identifier are stored in `localStorage`. Refreshing automatically restores the server lobby. The invite, room key, and rotating resume token remain in page memory, so the previous room is not rejoined after a refresh. Closing the tab also clears the access credential.

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

Every `v*` tag publishes Linux `amd64` and `arm64` archives plus `SHA256SUMS` on [GitHub Releases](https://github.com/TimeLordFang/DawnMeshServer/releases). Each archive contains the server executable with the browser assets embedded, plus license notices. Use configuration, Compose, reverse-proxy, and other deployment files from the matching repository tag:

```bash
sha256sum -c SHA256SUMS
install -m 0755 dawnmesh-server /usr/local/bin/dawnmesh-server
```

The process needs the environment variables described in `config.example.env` and write access to the parent directory of `DAWNMESH_DATABASE`. LiveKit remains a separate service.

When starting the binary directly from a shell, export the variables while loading `.env`. A plain `source .env` creates shell variables but does not export them, so Go's `os.Getenv` sees empty values:

```bash
set -a
source .env
set +a
./dawnmesh-server
```

Compose uses `env_file: .env` and does not require manually sourcing the file.

The repository includes [`deploy/dawnmesh-server.service`](deploy/dawnmesh-server.service) for running the release binary as a standalone systemd service:

```bash
sudo useradd --system --home-dir /var/lib/dawnmesh-server --shell /usr/sbin/nologin dawnmesh
sudo install -m 0755 dawnmesh-server /usr/local/bin/dawnmesh-server
sudo install -d -m 0750 -o root -g dawnmesh /etc/dawnmesh-server
sudo install -m 0640 -o root -g dawnmesh .env /etc/dawnmesh-server/dawnmesh.env
sudo install -m 0644 deploy/dawnmesh-server.service /etc/systemd/system/dawnmesh-server.service
```

Set the database and host-local LiveKit addresses in `/etc/dawnmesh-server/dawnmesh.env`:

```dotenv
DAWNMESH_LISTEN=127.0.0.1:8080
DAWNMESH_DATABASE=/var/lib/dawnmesh-server/dawnmesh.db
LIVEKIT_URL=http://127.0.0.1:7880
```

`StateDirectory=dawnmesh-server` creates `/var/lib/dawnmesh-server` with the correct ownership. After checking the remaining URLs, tokens, and LiveKit key/secret, enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dawnmesh-server
sudo systemctl status dawnmesh-server
sudo journalctl -u dawnmesh-server -f
```

## TURN and network ports

The LiveKit container uses host networking and listens on the host's IPv4 and IPv6 wildcard addresses. UDP 57882 is preferred for real-time voice, with ICE/TCP 57881 as fallback; allow both address families through the host firewall and cloud security group. `use_external_ip: true` discovers one public address. To advertise fixed public IPv4 and IPv6 addresses together, set `use_external_ip: false` and `node_ip: "public-IPv4,public-IPv6"`.

LiveKit's authenticated TURN service can support networks that block both UDP and ICE/TCP. TURN/TLS is a Layer 4 protocol and cannot use an Nginx HTTP `location`. Give it a dedicated public port/IP, or use Nginx `stream` SNI routing after checking client SNI behavior. Set `turn.external_tls: true` when Nginx terminates TURN TLS.

When Nginx and LiveKit run on the same host, they cannot both bind TCP 57881 and UDP 57882. Let host-networked LiveKit bind those ports directly and allow them through the firewall. When Nginx runs on a separate public gateway, its `stream` proxy may forward those ports to LiveKit's private address, but LiveKit must advertise the gateway's public IP: set `use_external_ip: false` and set `node_ip` accordingly. The startup log's `nodeIP` or `using external IPs` value must be an address the browser can actually reach. Investigate NAT hairpinning and port mappings before enabling `skip_external_ip_validation` for a `could not validate external IP` warning.

## Recovery behavior

- An ordinary member retains their identity for 30 minutes after an unexpected disconnect.
- A host chooses a 1–60 minute deadline when creating the room; the default is 30 minutes.
- If the host deadline expires while members remain online, ownership moves to the earliest online member.
- An entirely empty room is removed 30 minutes after the final disconnect, even when the host selected a longer deadline.
- Explicit host termination removes the room immediately.

SQLite data lives in the `dawnmesh-data` volume. Back up the database together with `.env` and `livekit.yaml`. Invite codes and chat content are not written to SQLite. The database stores a per-room random salt, a SHA-256 admission verifier, and a client-encrypted room-key envelope. An additional administrator-wrapped key is stored only with host consent. Four-digit codes remain vulnerable to offline guessing after a database leak.

## Security

New LiveKit join tokens start with audio publication disabled. After an authenticated management channel is established, the server applies the current persisted voice policy to the participant. Replaying an old token cannot restore revoked microphone access. Tokens expire after two minutes and API secrets stay server-side.

A four-digit invitation is not strong enough to protect a public service by itself. Generate a high-entropy `DAWNMESH_ACCESS_TOKEN`. `DAWNMESH_ADMIN_TOKEN` also protects host-authorized listening keys, so keep it away from ordinary App users, restrict database and configuration permissions, and keep images updated.

The management protocol is documented in [`docs/API.md`](docs/API.md). It is versioned as `2` (URLs retain `/api/v1`); the mobile clients reject incompatible versions and detect unexpected instance-ID changes.

## Development

```bash
go test -race ./...
go vet ./...
# Vulnerability scan tools and configuration are maintained in .github/workflows/ci.yml
```

Pushes to `main` and pull requests run module consistency checks, race-enabled tests, `go vet`, vulnerability scanning, and Linux cross-builds. A `v*` tag publishes release archives, checksums, and a multi-architecture GHCR image. Dependabot checks Go modules, Docker images, and GitHub Actions weekly.

Set `RELEASE_TAG` to the chosen, unused release tag before running:

```bash
git tag -a "$RELEASE_TAG" -m "DawnMesh Server $RELEASE_TAG"
git push origin "$RELEASE_TAG"
```

## License

DawnMesh Server is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). If you modify this project and make it available to users over a network, the AGPL requires you to offer those users the corresponding source. LiveKit and other dependencies remain under their respective licenses.

### Local build and packaging

Install Go (see `go.mod`), Node.js and npm (requirements in `frontend/package.json`), then run:

```bash
./scripts/build.sh                          # host platform, tests included
./scripts/build.sh --linux                  # Linux amd64 and arm64
./scripts/build.sh --os linux --arch arm64
```

The script installs locked dependencies, checks TypeScript, builds the browser
interfaces, runs protocol/Go tests and vet, then writes standalone executables,
`.tar.gz` packages with the binary and license notices and `SHA256SUMS` to `dist/`. Configuration and
deployment files are not copied into the packages; use the files from the
matching repository tag. `--skip-tests` skips tests but retains TypeScript
checking. The interfaces and LiveKit encryption worker are embedded in the Go
executable; Node.js is only a build dependency. LiveKit still runs as the
separate media service used by the existing deployment.

Frontend sources live in `frontend/`; generated assets are written to
`internal/server/web/` and are not tracked by Git. Use `./scripts/build.sh` for
release builds. Before running `go build`, `go test`, or `go vet` manually, run
`npm --prefix frontend ci && npm --prefix frontend run build`. Docker and GitHub
Actions perform this step automatically. Update your reverse proxy with the
`/ui/assets/` route from `deploy/nginx.example.conf`.

Hold Space anywhere in the room (except form inputs, other controls and open
dialogs) to talk. Release, window blur, page hiding and pointer cancellation stop
push-to-talk. Listening works independently of microphone permission. Click the
sound button if autoplay is blocked. Public access requires HTTPS and a reverse
proxy that preserves the client's microphone permissions policy.

Proxy rate limiting: `DAWNMESH_TRUSTED_PROXY_CIDRS` defaults to `127.0.0.1/32,::1/128`; an empty value disables forwarded-header trust. Bare-metal nginx can use the default. For Compose, inspect the application network with `docker network inspect`, add only its actual gateway `/32` (IPv6 `/128`), recreate the container and verify distinct client IP buckets. The nginx example overwrites incoming XFF. Configure nginx real-IP trust first if a CDN precedes it; never trust all private networks. Before upgrading, replace nonempty short access tokens with 32+ character values. Empty tokens still enable an open instance with a startup warning.
