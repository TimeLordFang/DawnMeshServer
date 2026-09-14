# DawnMesh Server API v1

All endpoints except `GET /healthz` require the optional deployment access credential as `Authorization: Bearer <token>` when `DAWNMESH_ACCESS_TOKEN` is configured. Member management endpoints also require the current rotating token in `X-Dawn-Session`.

JSON responses use UTF-8. Request bodies are limited to 64 KiB. Errors have the form `{"error":"message"}`.

## Discovery and rooms

- `GET /api/v1/info` returns `instanceId`, `name`, `protocolVersion`, and `maxRoomParticipants`.
- `GET /api/v1/rooms` returns visible room summaries.
- `POST /api/v1/rooms` accepts `name`, `nickname`, `deviceId`, `maxParticipants`, and `hostDisconnectTimeoutMinutes` (1–60).
- `POST /api/v1/rooms/{room}/admissions` creates a 30-second PAKE relay session. It accepts `nickname` and `deviceId`; no invite code is sent to this API.
- `POST /api/v1/rooms/{room}/resume` accepts `memberId` and the current `resumeToken`. A successful response rotates that token.

Creation and admission requests are bounded per source, device, room, and process. The default process room limit is 1,000 and can be changed with `DAWNMESH_MAX_ROOMS`.

## Authenticated management

- `PATCH /api/v1/rooms/{room}` with `{"name":"..."}` renames a room; host only.
- `PUT /api/v1/rooms/{room}/members/{member}/voice-policy` with `{"canSpeak":false}` changes audio publishing permission; host only.
- `POST /api/v1/rooms/{room}/handover` with `{"memberId":"..."}` transfers ownership to an online member; host only.
- `DELETE /api/v1/rooms/{room}/members/{member}` leaves voluntarily.
- `DELETE /api/v1/rooms/{room}` ends a room immediately; host only.

## Event channel

Connect to `WSS /api/v1/events` with both authentication headers. The channel sends room snapshots and relays the bounded SPAKE2 messages `pake_hello`, `pake_reply`, `pake_confirm`, and `pake_key`. After LiveKit joins, the App sends `media_ready`; the server then applies the persisted `canSpeak` policy through the LiveKit Room API.

The PAKE transcript binds the server instance ID, room ID, admission ID, member ID, and both protocol roles. The six-digit invite and random room key remain in clients. Chat payloads use a separate AES-256-GCM key and are opaque to this service.

## Connection grant

Create, completed admission, and resume responses return:

```json
{
  "room": {"id":"...", "name":"...", "memberCount":1, "maxParticipants":25, "hostNickname":"..."},
  "memberId":"...",
  "livekitUrl":"wss://rtc.example.com",
  "livekitToken":"...",
  "resumeToken":"...",
  "eventsUrl":"https://talk.example.com/api/v1/events"
}
```

LiveKit join tokens expire after two minutes, begin with `canPublish=false`, and never contain the deployment API secret, room invite, or E2EE key.
