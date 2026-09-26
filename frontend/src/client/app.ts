import * as DawnCrypto from './crypto';
import { bindPressToTalk } from '../shared/press-to-talk';
import { MicrophoneGate } from '../shared/microphone-gate';
import type { ActiveRoom, ClientState, RoomSummary, Member, Grant, Admission, EnterRoom, ManagementEvent, EventChannel, ServerInfo } from './types';
import * as LivekitClient from 'livekit-client';
import workerURL from 'livekit-client/e2ee-worker?url';
import { $ } from './dom';
import { asError, RequestError } from '../shared/dom';
import { mediaKey } from '../shared/media-key';
import '../shared/style.css';
import './style.css';


const utf8 = new TextEncoder();
const decoder = new TextDecoder();
const storage = {
  nickname: "dawnmesh-client-nickname",
  device: "dawnmesh-client-device",
  access: "dawnmesh-client-access",
  audioInput: "dawnmesh-client-audio-input",
  audioOutput: "dawnmesh-client-audio-output",
};

const state: ClientState = {
  accessToken: sessionStorage.getItem(storage.access) || "",
  nickname: localStorage.getItem(storage.nickname) || "",
  deviceId: localStorage.getItem(storage.device) || "",
  info: null,
  roomsTimer: undefined,
  active: null,
  toastTimer: undefined,
  wakeLock: null,
  preferHTTPEvents: false,
};

if (!state.deviceId || state.deviceId.length < 24) {
  state.deviceId = DawnCrypto.base64Url(crypto.getRandomValues(new Uint8Array(24)));
  localStorage.setItem(storage.device, state.deviceId);
}

function show(view: HTMLElement) {
  for (const element of [$("#setup-view"), $("#lobby-view"), $("#room-view")]) element.hidden = element !== view;
}

function toast(message: string, duration = 3600) {
  const element = $("#toast");
  window.clearTimeout(state.toastTimer);
  element.textContent = message;
  element.hidden = false;
  state.toastTimer = window.setTimeout(() => { element.hidden = true; }, duration);
}

function errorText(error: unknown) {
  const names = new Set();
  const visited = new Set<Error>();
  for (let current: Error | undefined = asError(error); current && !visited.has(current); current = current.cause ? asError(current.cause) : undefined) {
    visited.add(current);
    if (current.name) names.add(current.name);
    if (current.cause === current) break;
  }
  if (names.has("NotAllowedError") || names.has("SecurityError")) return "浏览器没有获得麦克风权限，请在网站权限中允许麦克风";
  if (names.has("NotFoundError") || names.has("DevicesNotFoundError")) return "没有找到可用麦克风，请检查系统麦克风权限和输入设备";
  if (names.has("NotReadableError") || names.has("TrackStartError")) return "麦克风暂时无法读取，请关闭占用麦克风的程序后重试";
  if (names.has("OverconstrainedError") || names.has("ConstraintNotSatisfiedError")) return "麦克风不支持当前采集参数";
  if (names.has("OperationError")) return "浏览器加密接口执行失败，请升级浏览器后重试";
  return asError(error).message || String(error) || "操作失败";
}

async function operation<T>(stage: string, callback: () => Promise<T>) {
  try {
    return await callback();
  } catch (_cause) { const cause = asError(_cause);
    const wrapped = new RequestError(`${stage}失败：${errorText(cause)}`);
    wrapped.cause = cause;
    wrapped.status = cause?.status;
    console.error(`[DawnMesh client] ${stage}`, cause);
    throw wrapped;
  }
}

function mediaFailureText(error: unknown) {
  const parts: string[] = [];
  const names = [];
  for (let current: Error | undefined = asError(error); current && !parts.includes(current.message); current = current.cause ? asError(current.cause) : undefined) {
    if (current.message) parts.push(current.message);
    if (current.name) names.push(current.name);
  }
  const detail = parts.join(" · ");
  const normalized = detail.toLowerCase();
  if (names.some((name) => name === "NotAllowedError" || name === "SecurityError")) {
    return "麦克风权限未开启：请允许当前网站使用麦克风后重新加入";
  }
  if (/401|403|unauthor|forbidden|jwt|token/.test(normalized)) {
    return "LiveKit 媒体鉴权失败：请核对 .env 与 livekit.yaml 的 API key/secret";
  }
  if (/signal|websocket|failed to fetch|server unreachable|networkerror/.test(normalized)) {
    return "LiveKit 信令连接失败：请检查 LIVEKIT_PUBLIC_URL、证书及 7880 的 WSS 反代";
  }
  if (/peerconnection|peer connection|pc connection|media.?connect|ice|candidate|dtls|connection timeout|timed out|could not establish/.test(normalized)) {
    return "LiveKit ICE 连接失败：请检查公布的公网 IP、UDP 57882 和 TCP 57881";
  }
  if (/e2ee|encrypt|key provider|worker/.test(normalized)) {
    return "LiveKit 端到端加密初始化失败：请检查浏览器 E2EE 和 Worker 支持";
  }
  return `LiveKit 媒体连接失败：${detail || "未知错误"}`;
}

async function diagnoseMediaFailure(error: unknown) {
  const browserDiagnosis = mediaFailureText(error);
  try {
    await api("/api/v1/media-health");
  } catch (_cause) { const cause = asError(_cause);
    if (cause?.status === 503) {
      return "LiveKit 服务端连接失败：请检查 LIVEKIT_URL、LiveKit 进程及两处 API key/secret";
    }
  }
  return browserDiagnosis;
}

function setBusy(button: HTMLButtonElement, busy: boolean, label = "处理中…") {
  if (!button.dataset.label) button.dataset.label = button.textContent || "";
  button.disabled = busy;
  button.textContent = busy ? label : button.dataset.label || "";
}

async function api<T = void>(path: string, { sessionToken = "", ...options }: RequestInit & { sessionToken?: string } = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (state.accessToken) headers.set("Authorization", `Bearer ${state.accessToken}`);
  if (sessionToken) headers.set("X-Dawn-Session", sessionToken);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, cache: "no-store", redirect: "error" });
  let payload: { error?: string } = {};
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new RequestError(payload.error || `服务器请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

function websocketURL(value: string) {
  const url = new URL(value, location.href);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.href;
}

function tokenProtocol(prefix: string, value: string) {
  return `${prefix}.${DawnCrypto.base64Url(utf8.encode(value))}`;
}

function openEventSocket(url: string, sessionToken: string) {
  const protocols = ["dawnmesh-v1", tokenProtocol("dawn-session", sessionToken)];
  if (state.accessToken) protocols.push(tokenProtocol("dawn-access", state.accessToken));
  // The embedded client always talks to the origin that served it. Preserve
  // the server-provided path while avoiding a second DNS/TLS origin and CORS.
  const announced = new URL(url, location.href);
  const sameOrigin = new URL(`${announced.pathname}${announced.search}`, location.origin);
  return new WebSocket(websocketURL(sameOrigin.href), protocols) as EventChannel;
}

function managementHeaders(sessionToken: string) {
  const headers = new Headers({ "Accept": "application/x-ndjson", "X-Dawn-Session": sessionToken });
  if (state.accessToken) headers.set("Authorization", `Bearer ${state.accessToken}`);
  return headers;
}

function openHTTPEventChannel(sessionToken: string) {
  const events = new EventTarget();
  const controller = new AbortController();
  let finished = false;
  const channel: EventChannel = {
    readyState: WebSocket.CONNECTING,
    intentional: false,
    transport: "http-stream",
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    send(data) {
      if (channel.readyState !== WebSocket.OPEN) throw new RequestError("管理通道暂不可用");
      api("/api/v1/events/send", { method: "POST", sessionToken, body: data }).catch((cause) => {
        if (cause?.status && cause.status !== 401 && cause.status !== 410) {
          events.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "error", error: errorText(cause) }) }));
        } else {
          finish(cause);
        }
      });
    },
    close() {
      if (finished) return;
      channel.readyState = WebSocket.CLOSING;
      controller.abort();
      finish();
    },
  };
  const finish = (cause: unknown = null) => {
    if (finished) return;
    finished = true;
    channel.readyState = WebSocket.CLOSED;
    if (cause) {
      events.dispatchEvent(new CustomEvent("error", { detail: cause }));
    }
    events.dispatchEvent(new Event("close"));
  };
  (async () => {
    try {
      const response = await fetch("/api/v1/events/stream", {
        headers: managementHeaders(sessionToken),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        let payload: { error?: string } = {};
        try { payload = await response.json(); } catch (_) {}
        const cause = new RequestError(payload.error || `HTTP 管理通道失败（${response.status}）`);
        cause.status = response.status;
        throw cause;
      }
      if (!response.body) throw new RequestError("浏览器不支持流式管理通道");
      channel.readyState = WebSocket.OPEN;
      events.dispatchEvent(new Event("open"));
      const reader = response.body.getReader();
      const streamDecoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += streamDecoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) events.dispatchEvent(new MessageEvent("message", { data: line }));
        }
      }
      pending += streamDecoder.decode();
      if (pending.trim()) events.dispatchEvent(new MessageEvent("message", { data: pending }));
      throw new RequestError("HTTP 管理通道已结束");
    } catch (_cause) { const cause = asError(_cause);
      if (cause?.name === "AbortError" && channel.intentional) finish();
      else finish(cause);
    }
  })();
  return channel;
}

function waitForOpen(socket: EventChannel, timeout = 12000) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new RequestError("管理通道连接超时")), timeout);
    socket.addEventListener("open", () => { window.clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", (event) => {
      window.clearTimeout(timer);
      reject((event as CustomEvent).detail || new RequestError("管理通道连接失败"));
    }, { once: true });
  });
}

async function openEventChannel(url: string, sessionToken: string, onMessage: EventListener) {
  if (state.preferHTTPEvents) {
    const stream = openHTTPEventChannel(sessionToken);
    stream.addEventListener("message", onMessage);
    await waitForOpen(stream);
    return stream;
  }
  let socket = openEventSocket(url, sessionToken);
  socket.addEventListener("message", onMessage);
  try {
    await waitForOpen(socket, 4000);
    socket.transport = "websocket";
    return socket;
  } catch (_cause) { const cause = asError(_cause);
    socket.intentional = true;
    socket.close(1000, "switching transport");
    console.warn("[DawnMesh client] WebSocket unavailable, switching to HTTP stream", cause);
    state.preferHTTPEvents = true;
  }
  socket = openHTTPEventChannel(sessionToken);
  socket.addEventListener("message", onMessage);
  await waitForOpen(socket);
  console.info("[DawnMesh client] management channel connected through HTTP stream fallback");
  return socket;
}

function randomInvite() {
  const limit = Math.floor(0x100000000 / 10000) * 10000;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= limit);
  return String(value[0] % 10000).padStart(4, "0");
}

function pakeIdentities(roomId: string, admissionId: string, memberId: string) {
  return [
    utf8.encode(`DawnMesh internet PAKE v1 client\0${state.info!.instanceId}\0${roomId}\0${admissionId}\0${memberId}`),
    utf8.encode(`DawnMesh internet PAKE v1 host\0${state.info!.instanceId}\0${roomId}`),
  ];
}

async function loadServer() {
  state.info = await api<ServerInfo>("/api/v1/info");
  if (state.info!.protocolVersion !== 1) throw new RequestError(`不兼容的服务器协议版本：${state.info!.protocolVersion}`);
  $("#server-name").textContent = state.info!.name || "DawnMesh Server";
  $("#max-participants-input").max = String(state.info!.maxRoomParticipants);
  $("#max-participants-input").value = String(Math.min(25, state.info!.maxRoomParticipants));
  $("#monitoring-option").hidden = !state.info!.adminListeningSupported;
  show($("#lobby-view"));
  await loadRooms();
  window.clearInterval(state.roomsTimer);
  state.roomsTimer = window.setInterval(() => {
    if (!$("#lobby-view").hidden) loadRooms().catch(() => {});
  }, 10000);
}

async function loadRooms() {
  const response = await api<{ rooms: RoomSummary[] }>("/api/v1/rooms");
  renderRooms(response.rooms || []);
  $("#rooms-updated").textContent = `更新于 ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function hue(value: string) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return hash % 360;
}

function renderRooms(rooms: RoomSummary[]) {
  const list = $("#room-list");
  list.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "还没有房间。创建一个，再邀请伙伴加入。";
    list.append(empty);
    return;
  }
  for (const room of rooms) {
    const card = document.createElement("article");
    card.className = "room-card";
    card.style.setProperty("--room-color", `hsl(${hue(room.id)} 75% 65%)`);
    const title = document.createElement("h3");
    title.textContent = room.name;
    const meta = document.createElement("p");
    meta.textContent = `房主：${room.hostNickname || "未知"}`;
    const footer = document.createElement("footer");
    const count = document.createElement("span");
    count.className = "occupancy";
    count.textContent = `${room.memberCount}/${room.maxParticipants} 人`;
    const join = document.createElement("button");
    join.className = "secondary-button compact";
    join.type = "button";
    join.textContent = "加入";
    join.disabled = room.memberCount >= room.maxParticipants;
    join.addEventListener("click", () => openJoin(room));
    footer.append(count, join);
    card.append(title, meta, footer);
    list.append(card);
  }
}

function openJoin(room: RoomSummary) {
  $("#join-room-id").value = room.id;
  $("#join-room-name").textContent = `加入“${room.name}”`;
  $("#invite-input").value = "";
  $("#join-error").textContent = "";
  $("#join-dialog").showModal();
  $("#invite-input").focus();
}

async function createRoom() {
  const button = $("#create-room-button");
  const error = $("#create-error");
  error.textContent = "";
  setBusy(button, true, "正在生成密钥…");
  try {
    const inviteCode = $("#create-invite-input").value.trim();
    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    const inviteScalar = await operation("邀请码密钥派生", () => DawnCrypto.deriveInviteScalar(inviteCode));
    const chatCipher = await operation("聊天密钥初始化", () => DawnCrypto.ChatCipher.create(roomKey));
    setBusy(button, true, "正在创建…");
    const body: { name: string; nickname: string; deviceId: string; maxParticipants: number; hostDisconnectTimeoutMinutes: number; monitoringKey?: string } = {
      name: $("#room-name-input").value.trim(),
      nickname: state.nickname,
      deviceId: state.deviceId,
      maxParticipants: Number($("#max-participants-input").value),
      hostDisconnectTimeoutMinutes: Number($("#host-timeout-input").value),
    };
    if ($("#allow-monitoring").checked) body.monitoringKey = mediaKey(DawnCrypto.base64Url(roomKey));
    const grant = await operation("服务端创建房间", () => api<Grant>("/api/v1/rooms", { method: "POST", body: JSON.stringify(body) }));
    $("#create-dialog").close();
    await enterRoom({ grant, roomKey, inviteCode, inviteScalar, chatCipher });
  } catch (_cause) { const cause = asError(_cause);
    error.textContent = errorText(cause);
  } finally {
    setBusy(button, false);
  }
}

async function completeAdmission(roomId: string, inviteCode: string) {
  const admission = await api<Admission>(`/api/v1/rooms/${encodeURIComponent(roomId)}/admissions`, {
    method: "POST",
    body: JSON.stringify({ nickname: state.nickname, deviceId: state.deviceId }),
  });
  const scalar = await operation("邀请码密钥派生", () => DawnCrypto.deriveInviteScalar(inviteCode));
  const pake = new DawnCrypto.Spake2({ isA: true, passwordScalar: scalar });
  const socket = await openEventChannel(admission.eventsUrl, admission.resumeToken, () => {});
  return new Promise<EnterRoom>((resolve, reject) => {
    let keys: DawnCrypto.PakeKeys | null = null;
    let settled = false;
    const timer = window.setTimeout(() => finish(new RequestError("邀请码验证超时")), 20000);
    const finish = (error: unknown, value?: Omit<EnterRoom, "inviteScalar">) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      socket.close(1000, "admission complete");
      error ? reject(error) : resolve({ ...value!, inviteScalar: scalar });
    };
    socket.addEventListener("message", async (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data) as ManagementEvent;
        if (event.admissionId !== admission.admissionId) return;
        if (event.type === "pake_reply") {
          const packet = DawnCrypto.fromBase64(event.body);
          if (packet.length !== 97) throw new RequestError("邀请码验证响应无效");
          const identities = pakeIdentities(roomId, admission.admissionId, admission.memberId);
          keys = await operation("邀请码验证", () => pake.finish(packet.slice(0, 65), identities[0], identities[1]));
          if (!DawnCrypto.timingSafeEqual(packet.slice(65), keys.confirmB)) throw new RequestError("邀请码不正确");
          socket.send(JSON.stringify({ type: "pake_confirm", admissionId: admission.admissionId, body: DawnCrypto.base64(keys.confirmA) }));
        } else if (event.type === "pake_key") {
          if (!keys) throw new RequestError("邀请码验证状态无效");
          const wrappingKey = await DawnCrypto.dawnHkdf(keys.sharedKey, "DawnMesh internet room key wrapping v1");
          const roomKey = await operation("房间密钥解密", () => DawnCrypto.aesDecrypt(wrappingKey, DawnCrypto.fromBase64(event.body), utf8.encode(admission.admissionId)));
          if (roomKey.length !== 32) throw new RequestError("房间密钥无效");
          finish(null, { grant: event.connection, roomKey, inviteCode });
        } else if (event.type === "admission_rejected" || event.type === "error") {
          finish(new RequestError(event.error || "邀请码验证失败"));
        }
      } catch (_cause) { const cause = asError(_cause); finish(cause); }
    });
    socket.addEventListener("close", () => finish(new RequestError("房主连接已中断")), { once: true });
    socket.addEventListener("error", () => finish(new RequestError("邀请码验证连接失败")), { once: true });
    socket.send(JSON.stringify({ type: "pake_hello", admissionId: admission.admissionId, body: DawnCrypto.base64(pake.message) }));
  });
}

async function enterRoom({ grant, roomKey, inviteCode, inviteScalar, chatCipher = null }: EnterRoom) {
  window.clearInterval(state.roomsTimer);
  const roomChatCipher = chatCipher || await operation("聊天密钥初始化", () => DawnCrypto.ChatCipher.create(roomKey));
  state.active = {
    grant,
    roomKey,
    inviteCode,
    inviteScalar,
    memberId: grant.memberId,
    resumeToken: grant.resumeToken,
    summary: grant.room,
    members: [],
    isHost: Boolean(grant.room?.isHost),
    canSpeak: true,
    muted: false,
    voiceMode: "ptt",
    ptt: false,
    audioProfile: (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ? "data" : "clarity",
    speaking: new Set(),
    messages: [],
    hostAdmissions: new Map(),
    chatCipher: roomChatCipher,
    socket: null,
    room: null,
    worker: null,
    leaving: false,
    roomEnded: false,
    eventsReconnectTimer: undefined,
    mediaReconnectTimer: undefined,
    mediaReconnectAttempts: 0,
    mediaReconnectStarted: 0,
    lastMediaError: "",
    microphonePermissionVerified: false,
    microphoneError: "",
    audioReady: false,
    audioInitializing: false,
    audioGeneration: 0,
    playbackBlocked: true,
    audioInputId: localStorage.getItem(storage.audioInput) || "",
    audioOutputId: localStorage.getItem(storage.audioOutput) || "",
    audioInputCount: 0,
    audioOutputCount: 0,
    remoteAudioTracks: 0,
    mediaDiagnostic: "正在连接媒体",
    fullReconnectTimer: undefined,
    fullReconnectStarted: 0,
    inviteVisible: false,
    inviteTimer: undefined,
    pttReleaseTimer: undefined,
    roomEndedTimer: undefined,
  };
  $("#audio-profile").value = state.active.audioProfile;
  show($("#room-view"));
  renderRoom();
  if (state.active.isHost) revealInvite();
  try {
    await connectEvents();
  } catch (_cause) { const cause = asError(_cause);
    toast(errorText(cause));
    scheduleFullReconnect("管理通道未连接，正在自动恢复");
  }
  try {
    await connectMedia(grant);
  } catch (_cause) { const cause = asError(_cause);
    const diagnosis = await diagnoseMediaFailure(cause);
    state.active!.lastMediaError = diagnosis;
    toast(diagnosis, 8000);
    scheduleMediaReconnect(diagnosis);
  }
  await acquireWakeLock();
}

async function connectEvents() {
  const active = state.active!;
  if (!active || active.leaving) return;
  if (active.socket) {
    active.socket.intentional = true;
    active.socket.close(1000, "replaced");
  }
  const socket = await openEventChannel(active.grant.eventsUrl, active.resumeToken, (message) => {
    handleManagementEvent(JSON.parse((message as MessageEvent<string>).data)).catch((cause) => toast(errorText(cause)));
  });
  if (state.active !== active || active.leaving) {
    socket.intentional = true;
    socket.close(1000, "room changed");
    return;
  }
  active.socket = socket;
  socket.addEventListener("close", () => {
    if (state.active !== active || active.leaving || socket.intentional) return;
    setRoomStatus("reconnecting", "管理通道中断，正在恢复");
    window.clearTimeout(active.eventsReconnectTimer);
    active.eventsReconnectTimer = window.setTimeout(() => connectEvents().catch(() => scheduleFullReconnect()), 2000);
  });
  if (state.active !== active || active.leaving) return;
  if (active.room?.state === "connected") {
    sendEvent({ type: "media_ready", memberId: active.memberId });
  }
  updateConnectionStatus(active);
}

async function handleManagementEvent(event: ManagementEvent) {
  const active = state.active!;
  if (!active) return;
  if (event.type === "snapshot") {
    const becameHost = !active.isHost && event.hostMemberId === active.memberId;
    active.summary = event.room || active.summary;
    active.isHost = event.hostMemberId === active.memberId;
    active.canSpeak = event.canSpeak ?? active.canSpeak;
    active.members = event.members || active.members;
    if (becameHost) revealInvite();
    if (!active.isHost) hideInvite(true);
    await applyMicrophone(currentMicWanted());
    renderRoom();
  } else if (event.type === "room_updated") {
    active.summary = event.room;
    renderRoom();
  } else if (event.type === "voice_policy") {
    if (event.memberId === active.memberId) {
      active.canSpeak = Boolean(event.canSpeak);
      if (!active.canSpeak) stopPTT(active);
      await applyMicrophone(currentMicWanted());
    }
    active.members = event.members || active.members;
    renderRoom();
  } else if (event.type === "role_changed") {
    const becameHost = !active.isHost && event.hostMemberId === active.memberId;
    active.isHost = event.hostMemberId === active.memberId;
    active.members = event.members || active.members;
    if (becameHost) revealInvite(); else hideInvite(true);
    renderRoom();
  } else if (event.type === "room_ended") {
    await handleRoomEnded(active);
  } else if (event.type === "error") {
    toast(event.error || "管理操作失败");
  } else if (event.type === "pake_hello" && active.isHost) {
    await hostPakeHello(event);
  } else if (event.type === "pake_confirm" && active.isHost) {
    await hostPakeConfirm(event);
  }
}

async function hostPakeHello(event: ManagementEvent) {
  const active = state.active!;
  const packet = DawnCrypto.fromBase64(event.body);
  if (packet.length !== 65 || active.hostAdmissions.size >= 8) return;
  for (const [id, pending] of active.hostAdmissions) if (Date.now() - pending.created > 30000) active.hostAdmissions.delete(id);
  const pake = new DawnCrypto.Spake2({ isA: false, passwordScalar: active.inviteScalar });
  const identities = pakeIdentities(active.summary.id, event.admissionId, event.memberId);
  const keys = await pake.finish(packet, identities[0], identities[1]);
  active.hostAdmissions.set(event.admissionId, { keys, created: Date.now() });
  sendEvent({ type: "pake_reply", admissionId: event.admissionId, body: DawnCrypto.base64(DawnCrypto.concat(pake.message, keys.confirmB)) });
}

async function hostPakeConfirm(event: ManagementEvent) {
  const active = state.active!;
  const pending = active.hostAdmissions.get(event.admissionId);
  active.hostAdmissions.delete(event.admissionId);
  const confirm = DawnCrypto.fromBase64(event.body);
  if (!pending || !DawnCrypto.timingSafeEqual(confirm, pending.keys.confirmA)) {
    sendEvent({ type: "admission_rejected", admissionId: event.admissionId });
    return;
  }
  const wrappingKey = await DawnCrypto.dawnHkdf(pending.keys.sharedKey, "DawnMesh internet room key wrapping v1");
  const packet = await DawnCrypto.aesEncrypt(wrappingKey, active.roomKey, utf8.encode(event.admissionId));
  sendEvent({ type: "pake_key", admissionId: event.admissionId, body: DawnCrypto.base64(packet) });
}

function sendEvent(value: Partial<ManagementEvent>) {
  const socket = state.active?.socket;
  if (socket?.readyState !== WebSocket.OPEN) throw new RequestError("管理通道暂不可用");
  socket.send(JSON.stringify(value));
}

function audioBitrate() {
  return ({ clarity: 32000, balanced: 24000, data: 12000 } as Record<string, number>)[state.active?.audioProfile || "balanced"] || 24000;
}

function audioOptions() {
  const inputId = state.active?.audioInputId;
  const capture: LivekitClient.AudioCaptureOptions = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  if (inputId) capture.deviceId = { exact: inputId };
  return {
    capture,
    publish: { audioBitrate: audioBitrate(), dtx: true, red: false, stopMicTrackOnMute: false },
  };
}

function fillDeviceSelect(select: HTMLSelectElement, devices: MediaDeviceInfo[], selectedId: string, fallbackLabel: string) {
  const previous = selectedId || select.value;
  select.replaceChildren();
  if (!devices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = fallbackLabel;
    select.append(option);
    select.disabled = true;
    return "";
  }
  select.disabled = false;
  devices.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `${fallbackLabel} ${index + 1}`;
    select.append(option);
  });
  if (devices.some((device) => device.deviceId === previous)) select.value = previous;
  return select.value;
}

async function refreshAudioDevices() {
  const active = state.active!;
  if (!active || !navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  active.audioInputCount = inputs.length;
  active.audioOutputCount = outputs.length;
  active.audioInputId = fillDeviceSelect($("#audio-input-device"), inputs, active.audioInputId, "默认麦克风");
  active.audioOutputId = fillDeviceSelect($("#audio-output-device"), outputs, active.audioOutputId, "系统默认扬声器");
  if (!("setSinkId" in HTMLMediaElement.prototype)) {
    $("#audio-output-device").replaceChildren(new Option("跟随系统输出设备", ""));
    $("#audio-output-device").disabled = true;
    active.audioOutputId = "";
  }
}

async function applyAudioOutput(element: HTMLMediaElement | null = null) {
  const active = state.active;
  if (!active?.audioOutputId) return;
  try {
    if (!("setSinkId" in HTMLMediaElement.prototype)) {
      active.audioOutputId = "";
      $("#audio-output-device").disabled = true;
      return;
    }
    if (element) await element.setSinkId(active.audioOutputId);
    else await active.room?.switchActiveDevice("audiooutput", active.audioOutputId);
  } catch (cause) {
    active.audioOutputId = "";
    localStorage.removeItem(storage.audioOutput);
    await active.room?.switchActiveDevice("audiooutput", "default").catch(() => {});
    toast(`无法切换扬声器，已恢复系统默认：${errorText(cause)}`);
  }
}

function cancelPTTRelease(active: ActiveRoom) {
  if (active.pttReleaseTimer !== undefined) window.clearTimeout(active.pttReleaseTimer);
  active.pttReleaseTimer = undefined;
}

function stopPTT(active: ActiveRoom) {
  cancelPTTRelease(active);
  active.ptt = false;
}

function disposeMicrophone(active: ActiveRoom) {
  cancelPTTRelease(active);
  active.audioGeneration += 1;
  active.micGate?.dispose();
  active.micTrack?.stop();
  active.micGate = undefined;
  active.micTrack = undefined;
  active.audioReady = false;
  active.ptt = false;
}

async function initializeAudioDevices(): Promise<void> {
  const active = state.active;
  if (!active) return;
  if (active.micTask) return active.micTask;
  if (active.audioReady && active.micTrack?.mediaStreamTrack.readyState === "live") {
    void resumeRemoteAudio();
    return;
  }
  if (!window.isSecureContext) throw new RequestError("请使用 HTTPS 或 localhost 访问，浏览器才允许使用麦克风");
  if (!navigator.mediaDevices?.getUserMedia) throw new RequestError("当前浏览器不支持麦克风采集");
  const room = active.room;
  if (!room || room.state !== "connected") throw new RequestError("语音尚未连接，请稍后重试");
  const generation = ++active.audioGeneration;
  const current = () => state.active === active && !active.leaving && active.room === room && active.audioGeneration === generation;
  active.audioInitializing = true;
  active.microphoneError = "";
  renderAudioSetup();
  // These calls must happen synchronously in the initiating click/key event.
  void resumeRemoteAudio(true);
  const capture = audioOptions().capture;
  const request = navigator.mediaDevices.getUserMedia({ audio: capture });
  const task = (async () => {
    let stream: MediaStream | undefined;
    let track: LivekitClient.LocalAudioTrack | undefined;
    try {
      try { stream = await request; }
      catch (cause) {
        if (!active.audioInputId || !["NotFoundError", "OverconstrainedError"].includes(asError(cause).name)) throw cause;
        active.audioInputId = "";
        localStorage.removeItem(storage.audioInput);
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...capture, deviceId: undefined } });
      }
      // Close the hardware gate before any await/publication. Permission alone
      // must never transmit audio, and a released first press stays silent.
      const mediaTrack = stream.getAudioTracks()[0];
      if (!mediaTrack) throw new RequestError("设备未提供音频轨道");
      mediaTrack.enabled = false;
      if (!current()) { stream.getTracks().forEach(t => t.stop()); return; }
      track = new LivekitClient.LocalAudioTrack(mediaTrack, mediaTrack.getConstraints(), false);
      track.stopOnMute = false;
      const gate = new MicrophoneGate();
      gate.attach(track);
      active.micTrack = track;
      active.micGate = gate;
      await track.mute();
      await room.localParticipant.publishTrack(track, { ...audioOptions().publish, source: LivekitClient.Track.Source.Microphone });
      if (!current()) { gate.dispose(); await room.localParticipant.unpublishTrack(track); return; }
      active.audioReady = true;
      active.microphonePermissionVerified = true;
      mediaTrack.addEventListener("ended", () => {
        if (!current()) return;
        disposeMicrophone(active);
        active.microphoneError = "麦克风已断开，请连接设备后重新启用";
        renderAudioSetup(); renderTalkState();
      }, { once: true });
      await refreshAudioDevices();
      await applyMicrophone(currentMicWanted());
    } catch (cause) {
      track?.stop();
      stream?.getTracks().forEach(t => t.stop());
      if (track) await room.localParticipant.unpublishTrack(track).catch(() => {});
      if (current()) {
        active.audioReady = false;
        stopPTT(active);
        active.microphoneError = errorText(cause);
      }
      throw cause;
    } finally {
      if (active.audioGeneration === generation) {
        active.audioInitializing = false;
        active.micTask = undefined;
      }
      if (state.active === active) { renderAudioSetup(); renderTalkState(); }
    }
  })();
  active.micTask = task;
  return task;
}

async function connectMedia(grant: Grant) {
  const active = state.active!;
  if (!active || active.leaving) return;
  if (typeof Worker === "undefined") throw new RequestError("当前浏览器不支持 WebRTC 端到端加密");
  if (typeof LivekitClient.isE2EESupported === "function" && !LivekitClient.isE2EESupported()) {
    throw new RequestError("当前浏览器不支持 LiveKit 端到端加密，请升级 Chrome、Edge、Firefox 或 Safari");
  }
  disposeMicrophone(active);
  active.audioInitializing = false;
  active.micTask = undefined;
  if (active.room) {
    active.intentionalMediaDisconnects ||= new WeakSet();
    active.intentionalMediaDisconnects.add(active.room);
    await active.room.disconnect().catch(() => {});
  }
  active.worker?.terminate();
  $("#remote-audio").replaceChildren();
  active.remoteAudioTracks = 0;
  const worker = new Worker(workerURL, { type: "module" });
  const keyProvider = new LivekitClient.ExternalE2EEKeyProvider();
  const options = audioOptions();
  const room = new LivekitClient.Room({
    // Mobile clients apply LiveKit E2EE to media only. Chat has its own
    // AES-GCM envelope, so keeping the data channel outside LiveKit E2EE makes
    // browser and mobile packets symmetric.
    e2ee: { keyProvider, worker },
    adaptiveStream: false,
    dynacast: false,
    audioCaptureDefaults: options.capture,
    publishDefaults: options.publish,
  });
  active.room = room;
  active.worker = worker;
  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
    if (state.active !== active || active.room !== room || active.leaving) return;
    if (track.kind !== LivekitClient.Track.Kind.Audio) return;
    const element = track.attach();
    element.autoplay = true;
    element.setAttribute("playsinline", "");
    $("#remote-audio").append(element);
    active.remoteAudioTracks += 1;
    void applyAudioOutput(element);
    element.play().catch(() => { active.playbackBlocked = true; renderAudioSetup(); });
    renderAudioSetup();
  });
  room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
    if (state.active !== active || active.room !== room || active.leaving) return;
    for (const element of track.detach()) element.remove();
    active.remoteAudioTracks = Math.max(0, active.remoteAudioTracks - 1);
    renderAudioSetup();
  });
  room.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
    if (state.active !== active || active.room !== room || active.leaving) return;
    active.speaking = new Set(speakers.map((participant) => participant.identity));
    renderMembers();
  });
  room.on(LivekitClient.RoomEvent.ParticipantPermissionsChanged, async (_, participant) => {
    if (state.active !== active || active.room !== room || active.leaving) return;
    if (participant?.identity !== active.memberId) return;
    active.canSpeak = room.localParticipant.permissions?.canPublish ?? active.canSpeak;
    if (!active.canSpeak) stopPTT(active);
    await applyMicrophone(currentMicWanted());
    renderTalkState();
  });
  room.on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, () => {
    if (state.active !== active || active.room !== room || active.leaving) return;
    active.playbackBlocked = !room.canPlaybackAudio;
    $("#resume-audio").hidden = room.canPlaybackAudio;
    renderAudioSetup();
  });
  room.on(LivekitClient.RoomEvent.MediaDevicesError, (cause) => {
    if (state.active !== active || active.room !== room || active.leaving) return;
    active.microphoneError = errorText(cause);
    active.mediaDiagnostic = active.microphoneError;
    console.warn("[DawnMesh client] media device error", cause);
    renderAudioSetup();
  });
  room.on(LivekitClient.RoomEvent.EncryptionError, (cause, participant) => {
    if (state.active !== active || active.room !== room || active.leaving) return;
    active.mediaDiagnostic = `端到端解密失败${participant?.identity ? `（${participant.identity}）` : ""}`;
    console.error("[DawnMesh client] E2EE media error", cause, participant);
    renderAudioSetup();
  });
  room.on(LivekitClient.RoomEvent.ParticipantEncryptionStatusChanged, (enabled) => {
    if (state.active !== active || active.room !== room || active.leaving || !enabled) return;
    active.mediaDiagnostic = "端到端加密已就绪";
    renderAudioSetup();
  });
  room.on(LivekitClient.RoomEvent.TrackSubscriptionFailed, (trackSid, cause, participant) => {
    if (state.active !== active || active.room !== room || active.leaving) return;
    active.mediaDiagnostic = "远端语音轨道订阅失败";
    console.error("[DawnMesh client] audio subscription failed", trackSid, cause, participant);
    renderAudioSetup();
  });
  room.on(LivekitClient.RoomEvent.Reconnecting, () => {
    if (state.active !== active || active.room !== room) return;
    stopPTT(active);
    void active.micGate?.set(false);
    setRoomStatus("reconnecting", "媒体连接波动，正在恢复");
    renderTalkState();
  });
  room.on(LivekitClient.RoomEvent.Reconnected, () => { updateConnectionStatus(active); void applyMicrophone(currentMicWanted()); });
  room.on(LivekitClient.RoomEvent.Disconnected, (reason) => {
    if (active.intentionalMediaDisconnects?.has(room)) return;
    if (state.active === active && !active.leaving) {
      stopPTT(active);
      void active.micGate?.set(false);
      renderTalkState();
      console.warn("[DawnMesh client] LiveKit media disconnected", reason);
      scheduleMediaReconnect(active.lastMediaError || "媒体连接中断，正在自动恢复");
    }
  });
  room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (state.active !== active || active.room !== room || active.leaving) return;
    if (topic === "dawnmesh.chat.v1" && participant) {
      receiveChat(payload, participant).catch((cause) => {
        console.warn("[DawnMesh client] ignored invalid chat packet", cause);
      });
    }
  });
  await operation("LiveKit 加密密钥初始化", () =>
    keyProvider.setKey(mediaKey(DawnCrypto.base64Url(active.roomKey))));
  await operation("LiveKit 端到端加密启用", () => room.setE2EEEnabled(true));
  if (state.active !== active || active.leaving || active.room !== room) { worker.terminate(); return; }
  await operation("LiveKit 媒体连接", () => room.connect(grant.livekitUrl, grant.livekitToken, { autoSubscribe: true }));
  if (state.active !== active || active.leaving || active.room !== room) {
    await room.disconnect(); worker.terminate(); return;
  }
  active.mediaDiagnostic = active.audioReady ? "媒体连接成功" : "媒体已连接，可直接启用收听";
  if (active.socket?.readyState === WebSocket.OPEN) sendEvent({ type: "media_ready", memberId: active.memberId });
  await refreshAudioDevices().catch(() => {});
  if (active.audioReady) {
    await resumeRemoteAudio(true);
    await applyMicrophone(currentMicWanted());
  }
  active.lastMediaError = "";
  updateConnectionStatus(active);
  renderAudioSetup();
}

function currentMicWanted() {
  const active = state.active!;
  return Boolean(active?.room?.state === "connected" && active.audioReady && active.canSpeak && !active.muted && (active.voiceMode === "auto" || active.ptt));
}

async function applyMicrophone(enabled: boolean) {
  const active = state.active;
  if (!active) return;
  try {
    await active.micGate?.set(enabled && currentMicWanted());
    if (state.active !== active) return;
    active.mediaDiagnostic = currentMicWanted() ? "麦克风正在发送" : "麦克风待机";
  } catch (cause) {
    stopPTT(active);
    active.micTrack && (active.micTrack.mediaStreamTrack.enabled = false);
    active.microphoneError = errorText(cause);
    toast(active.microphoneError);
  }
  if (state.active === active) { renderTalkState(); renderAudioSetup(); }
}

async function applyAudioBitrate() {
  const active = state.active!;
  const publications = active?.room?.localParticipant?.audioTrackPublications;
  if (!publications) return;
  for (const publication of publications.values()) {
    const sender = publication.track?.sender;
    if (!sender?.getParameters || !sender?.setParameters) continue;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) continue;
    for (const encoding of parameters.encodings) encoding.maxBitrate = audioBitrate();
    await sender.setParameters(parameters).catch(() => {});
  }
}

function updateConnectionStatus(active = state.active) {
  if (!active || state.active !== active || active.leaving) return;
  const managementReady = active.socket?.readyState === WebSocket.OPEN;
  const mediaReady = active.room?.state === "connected";
  if (managementReady && mediaReady) {
    setRoomStatus("connected", "连接安全 · 端到端加密");
  } else if (!managementReady) {
    setRoomStatus("reconnecting", "管理通道中断，正在自动恢复");
  } else {
    setRoomStatus("reconnecting", active.lastMediaError || "媒体连接中断，正在自动恢复");
  }
}

function scheduleFullReconnect(statusLabel = "连接中断，正在自动恢复") {
  const active = state.active!;
  if (!active || active.leaving || active.fullReconnectTimer) return;
  window.clearTimeout(active.eventsReconnectTimer);
  active.eventsReconnectTimer = undefined;
  window.clearTimeout(active.mediaReconnectTimer);
  active.mediaReconnectTimer = undefined;
  if (!active.fullReconnectStarted) active.fullReconnectStarted = Date.now();
  if (Date.now() - active.fullReconnectStarted > 30 * 60 * 1000) {
    setRoomStatus("failed", "恢复窗口已结束，请重新加入");
    return;
  }
  setRoomStatus("reconnecting", statusLabel);
  active.fullReconnectTimer = window.setTimeout(async () => {
    active.fullReconnectTimer = undefined;
    try {
      const grant = await api<Grant>(`/api/v1/rooms/${encodeURIComponent(active.summary.id)}/resume`, {
        method: "POST",
        body: JSON.stringify({ memberId: active.memberId, resumeToken: active.resumeToken }),
      });
      active.grant = grant;
      active.resumeToken = grant.resumeToken;
      await connectEvents();
      active.fullReconnectStarted = 0;
      if (active.room?.state === "connected") {
        active.mediaReconnectAttempts = 0;
        active.mediaReconnectStarted = 0;
        updateConnectionStatus(active);
        return;
      }
      try {
        await connectMedia(grant);
        active.mediaReconnectAttempts = 0;
        active.mediaReconnectStarted = 0;
      } catch (_cause) { const cause = asError(_cause);
        console.warn("[DawnMesh client] media recovery after session resume failed", cause);
        scheduleMediaReconnect("管理通道已恢复，媒体连接正在恢复");
      }
    } catch (_cause) { const cause = asError(_cause);
      console.warn("[DawnMesh client] session recovery failed", cause);
      scheduleFullReconnect("管理通道恢复失败，正在重试");
    }
  }, 2000);
}

function scheduleMediaReconnect(statusLabel = "媒体连接中断，正在自动恢复") {
  const active = state.active!;
  if (!active || active.leaving) return;
  setRoomStatus("reconnecting", statusLabel);
  if (active.mediaReconnectTimer) return;
  if (!active.mediaReconnectStarted) active.mediaReconnectStarted = Date.now();
  if (Date.now() - active.mediaReconnectStarted > 30 * 60 * 1000) {
    setRoomStatus("failed", "媒体恢复窗口已结束，请重新加入");
    return;
  }
  const delays = [2000, 4000, 8000, 15000, 30000];
  const delay = delays[Math.min(active.mediaReconnectAttempts, delays.length - 1)];
  active.mediaReconnectAttempts += 1;
  active.mediaReconnectTimer = window.setTimeout(async () => {
    active.mediaReconnectTimer = undefined;
    try {
      const media = await api<Pick<Grant, "livekitUrl" | "livekitToken">>(`/api/v1/rooms/${encodeURIComponent(active.summary.id)}/media-grant`, {
        method: "POST",
        sessionToken: active.resumeToken,
        body: JSON.stringify({}),
      });
      const grant = { ...active.grant, ...media };
      active.grant = grant;
      await connectMedia(grant);
      active.mediaReconnectAttempts = 0;
      active.mediaReconnectStarted = 0;
      active.lastMediaError = "";
    } catch (_cause) { const cause = asError(_cause);
      console.warn("[DawnMesh client] media recovery failed", cause);
      if (cause?.status === 401 || cause?.status === 410) {
        scheduleFullReconnect("会话已失效，正在恢复房间连接");
      } else {
        const seconds = Math.ceil(delays[Math.min(active.mediaReconnectAttempts, delays.length - 1)] / 1000);
        active.lastMediaError = await diagnoseMediaFailure(cause);
        scheduleMediaReconnect(`${active.lastMediaError}；${seconds} 秒后重试`);
      }
    }
  }, delay);
}

function setRoomStatus(mode: string, label: string) {
  const element = $("#room-connection-state");
  element.className = `room-status ${mode}`;
  element.lastChild!.textContent = label;
}

function revealInvite() {
  const active = state.active!;
  if (!active?.isHost) return;
  active.inviteVisible = true;
  window.clearTimeout(active.inviteTimer);
  active.inviteTimer = window.setTimeout(() => hideInvite(), 10000);
  renderInvite();
}

function hideInvite(remove = false) {
  const active = state.active!;
  if (!active) return;
  active.inviteVisible = false;
  window.clearTimeout(active.inviteTimer);
  if (remove) active.inviteTimer = undefined;
  renderInvite();
}

function renderInvite() {
  const active = state.active!;
  const card = $("#invite-card");
  card.hidden = !active?.isHost;
  if (!active?.isHost) return;
  $("#invite-code").textContent = active.inviteVisible ? active.inviteCode : "••••••";
  $("#toggle-invite").textContent = active.inviteVisible ? "◉" : "◎";
  $("#toggle-invite").setAttribute("aria-label", active.inviteVisible ? "隐藏邀请码" : "显示邀请码");
}

function initials(nickname: string) {
  const clean = (nickname || "?").split("#")[0].trim();
  return Array.from(clean).slice(0, 2).join("").toUpperCase() || "?";
}

function renderMembers() {
  const active = state.active!;
  if (!active) return;
  const grid = $("#member-grid");
  grid.replaceChildren();
  $("#member-count").textContent = `${active.members.length} 人`;
  for (const member of active.members) {
    const card = document.createElement("article");
    card.className = `member-card${active.speaking.has(member.id) ? " speaking" : ""}`;
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.style.setProperty("--avatar-hue", String(hue(member.id || member.nickname)));
    avatar.textContent = initials(member.nickname);
    const mic = document.createElement("span");
    mic.className = `mic-state${member.canSpeak ? "" : " blocked"}`;
    mic.textContent = member.canSpeak ? "•" : "×";
    mic.title = member.canSpeak ? "可以发言" : "已被房主封麦";
    avatar.append(mic);
    const name = document.createElement("p");
    name.className = "member-name";
    name.textContent = member.id === active.memberId ? `${member.nickname}（我）` : member.nickname;
    const role = document.createElement("p");
    role.className = `member-role${member.isHost ? " host" : ""}`;
    role.textContent = member.isHost ? "房主" : member.connected === false ? "暂时离线" : active.speaking.has(member.id) ? "正在说话" : "在线";
    card.append(avatar, name, role);
    if (active.isHost && !member.isHost && member.id !== active.memberId) {
      const actions = document.createElement("div");
      actions.className = "member-actions";
      actions.append(
        actionButton(member.canSpeak ? "封麦" : "开麦", () => setMemberVoice(member)),
        actionButton("转让", () => transferHost(member)),
      );
      card.append(actions);
    }
    grid.append(card);
  }
}

function actionButton(label: string, handler: () => Promise<void>) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await handler(); } catch (_cause) { const cause = asError(_cause); toast(errorText(cause)); } finally { button.disabled = false; }
  });
  return button;
}

async function setMemberVoice(member: Member) {
  const active = state.active!;
  await api(`/api/v1/rooms/${encodeURIComponent(active.summary.id)}/members/${encodeURIComponent(member.id)}/voice-policy`, {
    method: "PUT", sessionToken: active.resumeToken, body: JSON.stringify({ canSpeak: !member.canSpeak }),
  });
}

async function transferHost(member: Member) {
  if (!confirm(`把房主转让给“${member.nickname}”吗？`)) return;
  const active = state.active!;
  await api(`/api/v1/rooms/${encodeURIComponent(active.summary.id)}/handover`, {
    method: "POST", sessionToken: active.resumeToken, body: JSON.stringify({ memberId: member.id }),
  });
}

function renderTalkState() {
  const active = state.active!;
  if (!active) return;
  const button = $("#talk-button");
  button.setAttribute("aria-pressed", String(currentMicWanted()));
  const enabled = currentMicWanted();
  button.classList.toggle("active", enabled);
  button.classList.toggle("disabled", !active.canSpeak);
  button.disabled = !active.canSpeak || active.roomEnded;
  if (active.roomEnded) {
    $("#talk-label").textContent = "房间已解散";
    $("#talk-hint").textContent = "10 秒后返回房间列表";
  } else if (active.audioInitializing) {
    $("#talk-label").textContent = "等待麦克风授权";
    $("#talk-hint").textContent = "请在浏览器提示中允许麦克风";
  } else if (active.microphoneError) {
    $("#talk-label").textContent = "麦克风不可用";
    $("#talk-hint").textContent = "点击重试，仍可收听房间语音";
  } else if (!active.canSpeak) {
    $("#talk-label").textContent = "已被房主封麦";
    $("#talk-hint").textContent = "等待房主恢复发言";
  } else if (!active.audioReady) {
    $("#talk-label").textContent = "启用麦克风后通话";
    $("#talk-hint").textContent = "按住按钮或空格键开始授权";
  } else if (active.voiceMode === "auto") {
    $("#talk-label").textContent = active.muted ? "自动通话已静音" : "自动通话中";
    $("#talk-hint").textContent = active.muted ? "点击下方取消静音" : "麦克风持续开启，点击静音暂停";
  } else {
    const releasing = active.pttReleaseTimer !== undefined;
    $("#talk-label").textContent = releasing ? "正在收尾" : active.ptt ? "正在说话" : "按住说话";
    $("#talk-hint").textContent = releasing ? "正在发送尾音" : active.muted ? "本机已静音" : "按住空格键或此按钮，松开停止";
  }
  $("#mute-button").classList.toggle("active", active.muted);
  $("#mute-button").querySelector("small")!.textContent = active.muted ? "取消静音" : "静音";
  const notices = [];
  if (active.microphoneError) notices.push(active.microphoneError);
  if (active.summary.adminListening) notices.push("服务器管理员正在实时收听此房间");
  if (active.roomEnded) notices.push("房间已被群主解散，10 秒后返回房间列表");
  $("#call-notice").textContent = notices.join(" · ");
}

function renderAudioSetup() {
  const active = state.active!;
  if (!active) return;
  const card = $("#audio-setup");
  const button = $("#enable-audio-devices");
  card.classList.toggle("ready", active.audioReady);
  card.classList.remove("error");
  $("#microphone-setup").classList.toggle("error", Boolean(active.microphoneError));
  button.disabled = active.audioInitializing;
  button.textContent = active.audioInitializing ? "正在启用…" : active.audioReady ? "重新检测" : "启用麦克风";
  $("#audio-device-title").textContent = active.microphoneError
    ? (active.audioInputCount === 0 ? "未检测到麦克风" : "麦克风未就绪")
    : active.audioReady ? "麦克风已就绪" : (active.audioInputCount === 0 ? "未检测到麦克风" : "麦克风");
  $("#audio-device-status").textContent = active.microphoneError || (active.audioReady
    ? `麦克风 ${active.audioInputCount || 0} 个 · 输出设备 ${active.audioOutputCount || 0} 个`
    : active.audioInputCount === 0 ? "仍可正常收听；连接麦克风后可发言" : "仅在需要发言时启用麦克风");
  $("#audio-device-controls").hidden = !active.room || active.room.state !== "connected";
  const listeningReady = Boolean(active.room?.canPlaybackAudio && !active.playbackBlocked);
  $("#listening-title").textContent = listeningReady ? "收听已启用" : "收听声音";
  $("#listening-status").textContent = listeningReady
    ? `扬声器可播放 · 已订阅 ${active.remoteAudioTracks} 路远端语音`
    : "点击启用收听，不需要麦克风权限";
  $("#enable-listening").textContent = listeningReady ? "已启用" : "启用收听";
  $("#enable-listening").disabled = listeningReady;
  const playback = listeningReady ? "扬声器可播放" : "等待启用收听";
  $("#resume-audio").hidden = !active.room || listeningReady;
  $("#audio-diagnostic").textContent = `${active.mediaDiagnostic} · ${playback} · 已订阅 ${active.remoteAudioTracks} 路远端语音`;
}

function renderRoom() {
  const active = state.active!;
  if (!active) return;
  $("#active-room-name").textContent = active.summary.name;
  $("#rename-room").hidden = !active.isHost || active.roomEnded;
  $("#end-room").hidden = !active.isHost || active.roomEnded;
  for (const button of $("#voice-mode").querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.mode === active.voiceMode);
    button.disabled = active.roomEnded;
  }
  $("#mute-button").disabled = active.roomEnded;
  $("#chat-input").disabled = active.roomEnded;
  $("#chat-form").querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = active.roomEnded;
  renderInvite();
  renderMembers();
  renderTalkState();
  renderAudioSetup();
  renderChat();
}

async function resumeRemoteAudio(quiet = false) {
  const active = state.active;
  const room = active?.room;
  if (!room) return false;
  const playback = room.startAudio();
  const tracks = [...$("#remote-audio").querySelectorAll("audio")].map(audio => audio.play());
  const results = await Promise.allSettled([playback, ...tracks]);
  if (state.active !== active || active.room !== room) return false;
  const failed = results.find(result => result.status === "rejected");
  const ready = !failed && room.canPlaybackAudio;
  active.playbackBlocked = !ready;
  $("#resume-audio").hidden = ready;
  if (!ready && !quiet) toast("浏览器尚未允许播放，请再次点击启用收听");
  renderAudioSetup();
  return ready;
}

async function receiveChat(packet: Uint8Array<ArrayBuffer>, participant: LivekitClient.RemoteParticipant) {
  const active = state.active!;
  if (!active || packet.length < 29) return;
  const senderId = participant.identity;
  const clear = await active.chatCipher.decrypt(packet, utf8.encode(`dawnmesh.chat.v1\0${senderId}`));
  const message = JSON.parse(decoder.decode(clear));
  if (message.senderId !== senderId ||
      typeof message.id !== "string" || message.id.length > 160 ||
      typeof message.text !== "string" || utf8.encode(message.text).length > 1000 ||
      !Number.isSafeInteger(message.sentAt)) {
    throw new RequestError("invalid encrypted chat payload");
  }
  active.messages.push({ ...message, mine: senderId === active.memberId });
  if (active.messages.length > 100) active.messages.shift();
  renderChat();
}

async function sendChat(text: string) {
  const active = state.active!;
  const value = text.trim();
  if (!active || !value || utf8.encode(value).length > 1000) return;
  const message = {
    id: `${Date.now()}-${active.memberId}-${crypto.getRandomValues(new Uint32Array(1))[0]}`,
    senderId: active.memberId,
    senderName: state.nickname,
    text: value,
    sentAt: Date.now(),
  };
  const packet = await active.chatCipher.encrypt(utf8.encode(JSON.stringify(message)), utf8.encode(`dawnmesh.chat.v1\0${active.memberId}`));
  await active.room!.localParticipant.publishData(packet, { reliable: true, topic: "dawnmesh.chat.v1" });
  active.messages.push({ ...message, mine: true });
  renderChat();
}

function renderChat() {
  const active = state.active!;
  const list = $("#chat-list");
  if (!active) return;
  list.replaceChildren();
  if (!active.messages.length) {
    const empty = document.createElement("p");
    empty.className = "empty-chat";
    empty.textContent = "还没有消息";
    list.append(empty);
    return;
  }
  for (const message of active.messages) {
    const row = document.createElement("article");
    row.className = `chat-message${message.mine ? " mine" : ""}`;
    const meta = document.createElement("p");
    meta.className = "chat-meta";
    meta.textContent = `${message.mine ? "我" : message.senderName || "成员"} · ${new Date(message.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const bubble = document.createElement("p");
    bubble.className = "chat-bubble";
    bubble.textContent = message.text;
    row.append(meta, bubble);
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
}

async function cleanupRoom() {
  const active = state.active!;
  if (!active) return;
  active.leaving = true;
  disposeMicrophone(active);
  window.clearTimeout(active.inviteTimer);
  window.clearTimeout(active.eventsReconnectTimer);
  window.clearTimeout(active.mediaReconnectTimer);
  window.clearTimeout(active.fullReconnectTimer);
  cancelPTTRelease(active);
  window.clearTimeout(active.roomEndedTimer);
  active.roomEndedTimer = undefined;
  if (active.roomEnded) {
    window.clearTimeout(state.toastTimer);
    $("#toast").hidden = true;
  }
  if (active.socket) { active.socket.intentional = true; active.socket.close(1000, "leaving"); }
  await active.room?.disconnect().catch(() => {});
  active.worker?.terminate();
  $("#remote-audio").replaceChildren();
  state.active = null;
  await releaseWakeLock();
}

async function handleRoomEnded(active: ActiveRoom) {
  if (active.roomEnded || state.active !== active) return;
  active.roomEnded = true;
  active.leaving = true;
  stopPTT(active);
  disposeMicrophone(active);
  active.audioInitializing = false;
  active.micTask = undefined;
  window.clearTimeout(active.eventsReconnectTimer);
  window.clearTimeout(active.mediaReconnectTimer);
  window.clearTimeout(active.fullReconnectTimer);
  window.clearTimeout(active.inviteTimer);
  if (active.socket) {
    active.socket.intentional = true;
    active.socket.close(1000, "room ended");
    active.socket = null;
  }
  let roomToDisconnect: LivekitClient.Room | null = null;
  if (active.room) {
    active.intentionalMediaDisconnects ||= new WeakSet();
    active.intentionalMediaDisconnects.add(active.room);
    roomToDisconnect = active.room;
    active.room = null;
  }
  active.worker?.terminate();
  active.worker = null;
  $("#remote-audio").replaceChildren();
  setRoomStatus("failed", "房间已解散");
  toast("房间已被群主解散，10 秒后返回房间列表", 10_000);
  renderRoom();
  void roomToDisconnect?.disconnect().catch(() => {});
  active.roomEndedTimer = window.setTimeout(() => {
    active.roomEndedTimer = undefined;
    if (state.active !== active) return;
    void cleanupRoom()
      .then(() => loadServer())
      .catch(cause => toast(errorText(cause)));
  }, 10_000);
}

async function leaveRoom(endRoom = false) {
  const active = state.active!;
  if (!active) return;
  if (active.roomEnded && endRoom) return;
  const question = endRoom ? "确定立即解散房间吗？所有成员都会断开。" : "确定离开当前房间吗？";
  if (!confirm(question)) return;
  try {
    const path = endRoom
      ? `/api/v1/rooms/${encodeURIComponent(active.summary.id)}`
      : `/api/v1/rooms/${encodeURIComponent(active.summary.id)}/members/${encodeURIComponent(active.memberId)}`;
    await api(path, { method: "DELETE", sessionToken: active.resumeToken, body: JSON.stringify({}) });
  } catch (_cause) { const cause = asError(_cause);
    if (endRoom) { toast(errorText(cause)); return; }
  }
  await cleanupRoom();
  await loadServer();
}

async function acquireWakeLock() {
  if (!navigator.wakeLock || document.visibilityState !== "visible") return;
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch (_) {}
}

async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch (_) {}
  state.wakeLock = null;
}

$("#nickname-input").value = state.nickname;
$("#access-token-input").value = state.accessToken;

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#connect-server-button");
  const error = $("#setup-error");
  state.nickname = $("#nickname-input").value.trim();
  state.accessToken = $("#access-token-input").value.trim();
  error.textContent = "";
  setBusy(button, true, "正在连接…");
  try {
    localStorage.setItem(storage.nickname, state.nickname);
    sessionStorage.setItem(storage.access, state.accessToken);
    await loadServer();
  } catch (_cause) { const cause = asError(_cause); error.textContent = errorText(cause); } finally { setBusy(button, false); }
});

$("#toggle-access-token").addEventListener("click", () => {
  const input = $("#access-token-input");
  input.type = input.type === "password" ? "text" : "password";
  $("#toggle-access-token").textContent = input.type === "password" ? "显示" : "隐藏";
});
$("#refresh-rooms").addEventListener("click", () => loadRooms().catch((cause) => toast(errorText(cause))));
$("#change-server").addEventListener("click", () => show($("#setup-view")));
$("#open-create-room").addEventListener("click", () => {
  $("#create-error").textContent = "";
  $("#room-name-input").value = `${state.nickname}的房间`;
  $("#create-invite-input").value = randomInvite();
  $("#create-dialog").showModal();
});
$("#regenerate-invite").addEventListener("click", () => { $("#create-invite-input").value = randomInvite(); });
$("#create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") { $("#create-dialog").close(); return; }
  if ((event.currentTarget as HTMLFormElement).reportValidity()) createRoom();
});
$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") { $("#join-dialog").close(); return; }
  if (!(event.currentTarget as HTMLFormElement).reportValidity()) return;
  const button = $("#join-room-button");
  const error = $("#join-error");
  error.textContent = "";
  setBusy(button, true, "正在验证…");
  try {
    const result = await completeAdmission($("#join-room-id").value, $("#invite-input").value);
    $("#join-dialog").close();
    await enterRoom(result);
  } catch (_cause) { const cause = asError(_cause); error.textContent = errorText(cause); } finally { setBusy(button, false); }
});
$("#leave-room").addEventListener("click", () => leaveRoom(false));
$("#end-room").addEventListener("click", () => leaveRoom(true));
$("#toggle-invite").addEventListener("click", () => state.active?.inviteVisible ? hideInvite() : revealInvite());
$("#resume-audio").addEventListener("click", async () => {
  await resumeRemoteAudio();
});
$("#enable-listening").addEventListener("click", async () => {
  await resumeRemoteAudio();
});
$("#voice-mode").addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
  if (!button || !state.active || state.active.roomEnded) return;
  state.active.voiceMode = button.dataset.mode === "auto" ? "auto" : "ptt";
  stopPTT(state.active);
  if (state.active.voiceMode === "auto" && !state.active.audioReady) {
    try { await initializeAudioDevices(); } catch (_cause) { const cause = asError(_cause); toast(errorText(cause), 8000); }
  }
  await applyMicrophone(currentMicWanted());
  renderRoom();
});
$("#enable-audio-devices").addEventListener("click", async () => {
  try { await initializeAudioDevices(); } catch (_cause) { const cause = asError(_cause); toast(errorText(cause), 8000); }
});
$("#audio-input-device").addEventListener("change", async event => {
  const active = state.active;
  if (!active) return;
  active.audioInputId = (event.target as HTMLSelectElement).value;
  localStorage.setItem(storage.audioInput, active.audioInputId);
  const previous = active.micTrack;
  disposeMicrophone(active);
  active.micTask = undefined;
  active.audioInitializing = false;
  // Do not await unpublication before requesting capture in this user gesture.
  if (previous) void active.room?.localParticipant.unpublishTrack(previous).catch(() => {});
  try { await initializeAudioDevices(); } catch (cause) { toast(errorText(cause)); }
});

$("#audio-output-device").addEventListener("change", async (event) => {
  const active = state.active!;
  if (!active) return;
  active.audioOutputId = (event.target as HTMLSelectElement).value;
  localStorage.setItem(storage.audioOutput, active.audioOutputId);
  await applyAudioOutput();
});
$("#mute-button").addEventListener("click", async () => {
  if (!state.active) return;
  stopPTT(state.active);
  state.active.muted = !state.active.muted;
  await applyMicrophone(currentMicWanted());
});
$("#audio-profile").addEventListener("change", async (event) => {
  if (!state.active) return;
  state.active.audioProfile = (event.target as HTMLSelectElement).value;
  await applyAudioBitrate();
  toast(`已切换到${(event.target as HTMLSelectElement).selectedOptions[0].textContent.split(" · ")[0]}音质`);
});

const talk = $("#talk-button");
async function setPTT(pressed: boolean, immediate = false) {
  const active = state.active;
  if (!active) return;
  if (!pressed) {
    if (!immediate && active.ptt && active.audioReady && active.micTrack?.mediaStreamTrack.readyState === "live") {
      cancelPTTRelease(active);
      active.pttReleaseTimer = window.setTimeout(() => {
        active.pttReleaseTimer = undefined;
        if (state.active !== active) return;
        active.ptt = false;
        void applyMicrophone(currentMicWanted());
      }, 500);
      renderTalkState();
      return;
    }
    stopPTT(active);
    await applyMicrophone(currentMicWanted());
    return;
  }
  if (active.voiceMode !== "ptt" || active.muted || !active.canSpeak) return;
  cancelPTTRelease(active);
  active.ptt = true;
  renderTalkState();
  try {
    if (!active.audioReady) await initializeAudioDevices();
    if (state.active === active) await applyMicrophone(currentMicWanted());
  } catch (cause) { toast(errorText(cause), 8000); }
}
bindPressToTalk(talk, {
  available: () => Boolean(state.active && state.active.voiceMode === "ptt" && state.active.canSpeak && !state.active.muted && !$("#room-view").hidden),
  change: (pressed, immediate) => { void setPTT(pressed, immediate); },
  unlock: () => { void resumeRemoteAudio(true); },
});

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const value = input.value;
  input.value = "";
  try { await sendChat(value); } catch (_cause) { const cause = asError(_cause); input.value = value; toast(errorText(cause)); }
});
$("#rename-room").addEventListener("click", () => {
  $("#rename-input").value = state.active?.summary.name || "";
  $("#rename-error").textContent = "";
  $("#rename-dialog").showModal();
});
$("#rename-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") { $("#rename-dialog").close(); return; }
  const active = state.active!;
  if (!active || !(event.currentTarget as HTMLFormElement).reportValidity()) return;
  try {
    await api(`/api/v1/rooms/${encodeURIComponent(active.summary.id)}`, {
      method: "PATCH", sessionToken: active.resumeToken, body: JSON.stringify({ name: $("#rename-input").value.trim() }),
    });
    $("#rename-dialog").close();
  } catch (_cause) { const cause = asError(_cause); $("#rename-error").textContent = errorText(cause); }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    void setPTT(false, true);
    hideInvite();
  } else if (state.active) {
    acquireWakeLock();
  }
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if (state.active) refreshAudioDevices().then(renderAudioSetup).catch(() => {});
});
window.addEventListener("pagehide", () => {
  if (state.active) {
    disposeMicrophone(state.active);
    state.active.audioInitializing = false;
    state.active.micTask = undefined;
  }
  void releaseWakeLock();
});

if (!window.isSecureContext) {
  $("#setup-error").textContent = "网页对讲需要 HTTPS 安全上下文才能使用麦克风和端到端加密。";
  $("#connect-server-button").disabled = true;
} else if (state.nickname && state.accessToken) {
  const button = $("#connect-server-button");
  setBusy(button, true, "正在恢复…");
  loadServer()
    .catch((cause) => { $("#setup-error").textContent = errorText(cause); })
    .finally(() => setBusy(button, false));
}
