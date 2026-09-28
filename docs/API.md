# DawnMesh Server protocol 2 (HTTP paths retain /api/v1)

All client endpoints except `GET /healthz` require the optional deployment access credential as `Authorization: Bearer <token>` when `DAWNMESH_ACCESS_TOKEN` is configured. Member management endpoints also require the current rotating token in `X-Dawn-Session`. Admin endpoints require the separate `DAWNMESH_ADMIN_TOKEN`; the client access token is never accepted for them.

`GET /api/v1/media-health` verifies that DawnMesh Server can reach and authenticate to the configured LiveKit control API. It returns `200` with `{"status":"ok"}` or `503` with a sanitized error. It does not test the browser-facing WSS endpoint or ICE media ports.

JSON responses use UTF-8. Request bodies are limited to 64 KiB. Errors have the form `{"error":"message"}`.

## Discovery and rooms

- `GET /api/v1/info` returns `instanceId`, `name`, `protocolVersion`, `maxRoomParticipants`, and `adminListeningSupported`.
- `GET /api/v1/rooms` returns visible room summaries.
- `POST /api/v1/rooms` accepts `name`, `nickname`, `deviceId`, `maxParticipants`, `hostDisconnectTimeoutMinutes` (1–60), and the required Base64 fields `joinSalt` (16 bytes), `joinCredential` (32 bytes), `wrappedRoomKey` (60 bytes).
- `POST /api/v1/rooms/{room}/join` accepts `nickname`, `deviceId`, and `joinCredential`. The server checks the credential and room capacity, persists the member, and returns a connection grant plus `wrappedRoomKey`. No host connection is required. The former `/admissions` route and PAKE relay are removed.
- `POST /api/v1/rooms/{room}/resume` accepts `memberId` and the current `resumeToken`. A successful response rotates that token.
- `POST /api/v1/rooms/{room}/media-grant` uses the current `X-Dawn-Session` token to refresh only the short-lived LiveKit grant. It does not rotate the member token or interrupt the management WebSocket.

Creation is bounded per source/device and process room capacity. Join requests are limited to 20 per source, 10 per device, and 30 per room per minute before credential comparison. The default process room limit is 1,000 and can be changed with `DAWNMESH_MAX_ROOMS`.

## Authenticated management

- `PATCH /api/v1/rooms/{room}` with `{"name":"..."}` renames a room; host only.
- `PUT /api/v1/rooms/{room}/members/{member}/voice-policy` with `{"canSpeak":false}` changes audio publishing permission; host only.
- `POST /api/v1/rooms/{room}/handover` with `{"memberId":"..."}` transfers ownership to an online member; host only.
- `DELETE /api/v1/rooms/{room}/members/{member}` leaves voluntarily.
- `DELETE /api/v1/rooms/{room}` ends a room immediately; host only.
- `PUT /api/v1/rooms/{room}/presence-announcements` with `{"enabled":true}` changes the room-wide departure announcements; current host only.

## Event channel

Connect to `WSS /api/v1/events` with both authentication headers. The channel sends room snapshots, role/policy updates, and explicit `member_left` events. It does not validate invitations. After LiveKit joins, the App sends `media_ready`; the server then applies the latest persisted `canSpeak` policy through the LiveKit Room API, with the current host always allowed to publish. Updates for one identity are serialized and rechecked after network IO. Clients repeat `media_ready` every ten seconds while room policy and SDK permissions disagree (server limit: 30 per member per minute). Browser clients automatically fall back to `GET /api/v1/events/stream` (newline-delimited JSON) and `POST /api/v1/events/send` when a reverse proxy rejects the WebSocket upgrade. The fallback endpoints use the normal `Authorization` and `X-Dawn-Session` headers.

Four-digit ASCII invitations are expanded with scrypt (N=16384, r=8, p=1, output=64 bytes). The salt input is UTF-8 `DawnMesh internet invite v2` followed by the room's random 16-byte salt. The first 32 output bytes form the admission credential; the remaining 32 bytes wrap the independently random room key with AES-256-GCM. The envelope is a 12-byte nonce followed by 32-byte ciphertext and a 16-byte tag; AAD equals the scrypt salt input. Credentials use canonical padded Base64. SQLite stores SHA-256 of the encoded credential, the random salt, and the opaque envelope. Room summaries expose only `joinSalt`, never the verifier or envelope. Use HTTPS: the admission credential is a bearer secret.

This avoids storing raw invite codes or raw default room keys. A leaked database still permits offline guessing of a four-digit code; server-side verification is a different trust model from host-mediated PAKE. Chat uses a purpose-separated AES-256-GCM key. Existing rooms without admission credentials must be recreated after upgrading to server 0.2.5 / Android 1.0.3.

Snapshot `connected` records the management channel for server retention and permissions. Room clients use LiveKit participant membership for the visible online badge, preserving last-known peer state while their own media connection recovers. A late close from an old management connection cannot overwrite a replacement stream's online status.

The embedded `/client/` page uses the same event endpoint. Browser APIs cannot attach arbitrary headers to a WebSocket handshake, so it offers these `Sec-WebSocket-Protocol` values:

- `dawnmesh-v1`
- `dawn-access.<Base64URL(UTF-8 access token)>` when an access token is configured
- `dawn-session.<Base64URL(UTF-8 rotating session token)>`

The server negotiates only `dawnmesh-v1`; credential entries are authenticated before the upgrade. This keeps credentials out of the URL and preserves the existing header-based Android protocol. Reverse proxies must not log `Sec-WebSocket-Protocol`, because the browser credentials are carried in that header.

## Connection grant

Create, join, and resume responses return:

```json
{
  "room": {"id":"...", "name":"...", "memberCount":1, "maxParticipants":25, "hostNickname":"...", "isHost":true},
  "memberId":"...",
  "livekitUrl":"wss://rtc.example.com",
  "livekitToken":"...",
  "resumeToken":"...",
  "eventsUrl":"https://talk.example.com/api/v1/events"
}
```

LiveKit join tokens expire after two minutes, begin with `canPublish=false`, and never contain the deployment API secret, room invite, or E2EE key.

## Server administration

The embedded console is served from `GET /admin/`. Its static assets do not require authentication, contain no secrets, and are protected by a restrictive Content Security Policy. All data and mutation requests require `Authorization: Bearer <DAWNMESH_ADMIN_TOKEN>`:

- `GET /api/v1/admin/overview` returns instance limits, uptime, aggregate counts, rooms, safe member state, and recovery deadlines. Device IDs and credential hashes are omitted.
- `PATCH /api/v1/admin/rooms/{room}` with `{"name":"..."}` renames a room and broadcasts the update.
- `PUT /api/v1/admin/rooms/{room}/members/{member}/voice-policy` with `{"canSpeak":false}` persists and applies microphone permission. The host cannot be muted.
- `DELETE /api/v1/admin/rooms/{room}` ends a room immediately.
- `POST /api/v1/admin/rooms/{room}/listen` creates a short-lived, hidden, subscribe-only LiveKit listener when the room host enabled monitoring at creation. The response includes the E2EE key and is available only to the administrator.
- `PUT /api/v1/admin/listeners/{listener}` renews the 35-second listener lease; `DELETE` ends it. Active listener state is included in room snapshots so every App participant can display it.

Admin APIs return `503` when `DAWNMESH_ADMIN_TOKEN` is unset. Invalid credentials are rate-limited per source address.

`POST /api/v1/rooms` accepts the optional `monitoringKey` only when administrator access is configured. It must encode exactly 32 bytes with Base64URL. The key is wrapped with AES-256-GCM under a key derived from `DAWNMESH_ADMIN_TOKEN` before SQLite persistence. Omitting the field keeps administrator listening unavailable for that room.
