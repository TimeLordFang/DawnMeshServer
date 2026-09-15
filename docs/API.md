# DawnMesh Server API v1

All client endpoints except `GET /healthz` require the optional deployment access credential as `Authorization: Bearer <token>` when `DAWNMESH_ACCESS_TOKEN` is configured. Member management endpoints also require the current rotating token in `X-Dawn-Session`. Admin endpoints require the separate `DAWNMESH_ADMIN_TOKEN`; the client access token is never accepted for them.

`GET /api/v1/media-health` verifies that DawnMesh Server can reach and authenticate to the configured LiveKit control API. It returns `200` with `{"status":"ok"}` or `503` with a sanitized error. It does not test the browser-facing WSS endpoint or ICE media ports.

JSON responses use UTF-8. Request bodies are limited to 64 KiB. Errors have the form `{"error":"message"}`.

## Discovery and rooms

- `GET /api/v1/info` returns `instanceId`, `name`, `protocolVersion`, `maxRoomParticipants`, and `adminListeningSupported`.
- `GET /api/v1/rooms` returns visible room summaries.
- `POST /api/v1/rooms` accepts `name`, `nickname`, `deviceId`, `maxParticipants`, and `hostDisconnectTimeoutMinutes` (1–60).
- `POST /api/v1/rooms/{room}/admissions` creates a 30-second PAKE relay session. It accepts `nickname` and `deviceId`; no invite code is sent to this API.
- `POST /api/v1/rooms/{room}/resume` accepts `memberId` and the current `resumeToken`. A successful response rotates that token.
- `POST /api/v1/rooms/{room}/media-grant` uses the current `X-Dawn-Session` token to refresh only the short-lived LiveKit grant. It does not rotate the member token or interrupt the management WebSocket.

Creation and admission requests are bounded per source, device, room, and process. The default process room limit is 1,000 and can be changed with `DAWNMESH_MAX_ROOMS`.

## Authenticated management

- `PATCH /api/v1/rooms/{room}` with `{"name":"..."}` renames a room; host only.
- `PUT /api/v1/rooms/{room}/members/{member}/voice-policy` with `{"canSpeak":false}` changes audio publishing permission; host only.
- `POST /api/v1/rooms/{room}/handover` with `{"memberId":"..."}` transfers ownership to an online member; host only.
- `DELETE /api/v1/rooms/{room}/members/{member}` leaves voluntarily.
- `DELETE /api/v1/rooms/{room}` ends a room immediately; host only.

## Event channel

Connect to `WSS /api/v1/events` with both authentication headers. The channel sends room snapshots and relays the bounded SPAKE2 messages `pake_hello`, `pake_reply`, `pake_confirm`, and `pake_key`. After LiveKit joins, the App sends `media_ready`; the server then applies the persisted `canSpeak` policy through the LiveKit Room API. Browser clients automatically fall back to `GET /api/v1/events/stream` (newline-delimited JSON) and `POST /api/v1/events/send` when a reverse proxy rejects the WebSocket upgrade. The fallback endpoints use the normal `Authorization` and `X-Dawn-Session` headers.

The PAKE transcript binds the server instance ID, room ID, admission ID, member ID, and both protocol roles. The six-digit invite and random room key remain in clients. Chat payloads use a separate AES-256-GCM key and are opaque to this service.

The embedded `/client/` page uses the same event endpoint. Browser APIs cannot attach arbitrary headers to a WebSocket handshake, so it offers these `Sec-WebSocket-Protocol` values:

- `dawnmesh-v1`
- `dawn-access.<Base64URL(UTF-8 access token)>` when an access token is configured
- `dawn-session.<Base64URL(UTF-8 rotating session token)>`

The server negotiates only `dawnmesh-v1`; credential entries are authenticated before the upgrade. This keeps credentials out of the URL and preserves the existing header-based Android protocol. Reverse proxies must not log `Sec-WebSocket-Protocol`, because the browser credentials are carried in that header.

## Connection grant

Create, completed admission, and resume responses return:

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
