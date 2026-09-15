"use strict";

const $ = (selector) => document.querySelector(selector);
const utf8 = new TextEncoder();
const decoder = new TextDecoder();
const storage = {
  nickname: "dawnmesh-client-nickname",
  device: "dawnmesh-client-device",
  access: "dawnmesh-client-access",
};

const state = {
  accessToken: sessionStorage.getItem(storage.access) || "",
  nickname: localStorage.getItem(storage.nickname) || "",
  deviceId: localStorage.getItem(storage.device) || "",
  info: null,
  roomsTimer: null,
  active: null,
  toastTimer: null,
  wakeLock: null,
};

if (!state.deviceId || state.deviceId.length < 24) {
  state.deviceId = DawnCrypto.base64Url(crypto.getRandomValues(new Uint8Array(24)));
  localStorage.setItem(storage.device, state.deviceId);
}

function show(view) {
  for (const element of [$("#setup-view"), $("#lobby-view"), $("#room-view")]) element.hidden = element !== view;
}

function toast(message, duration = 3600) {
  const element = $("#toast");
  window.clearTimeout(state.toastTimer);
  element.textContent = message;
  element.hidden = false;
  state.toastTimer = window.setTimeout(() => { element.hidden = true; }, duration);
}

function errorText(error) {
  if (error?.name === "NotAllowedError") return "浏览器没有获得麦克风权限";
  return error?.message || String(error) || "操作失败";
}

function setBusy(button, busy, label = "处理中…") {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? label : button.dataset.label;
}

async function api(path, { sessionToken = "", ...options } = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (state.accessToken) headers.set("Authorization", `Bearer ${state.accessToken}`);
  if (sessionToken) headers.set("X-Dawn-Session", sessionToken);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, cache: "no-store", redirect: "error" });
  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(payload.error || `服务器请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function websocketURL(value) {
  const url = new URL(value, location.href);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.href;
}

function tokenProtocol(prefix, value) {
  return `${prefix}.${DawnCrypto.base64Url(utf8.encode(value))}`;
}

function openEventSocket(url, sessionToken) {
  const protocols = ["dawnmesh-v1", tokenProtocol("dawn-session", sessionToken)];
  if (state.accessToken) protocols.push(tokenProtocol("dawn-access", state.accessToken));
  // The embedded client always talks to the origin that served it. Preserve
  // the server-provided path while avoiding a second DNS/TLS origin and CORS.
  const announced = new URL(url, location.href);
  const sameOrigin = new URL(`${announced.pathname}${announced.search}`, location.origin);
  return new WebSocket(websocketURL(sameOrigin.href), protocols);
}

function waitForOpen(socket, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("管理通道连接超时")), timeout);
    socket.addEventListener("open", () => { window.clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { window.clearTimeout(timer); reject(new Error("管理通道连接失败")); }, { once: true });
  });
}

function randomInvite() {
  const limit = Math.floor(0x100000000 / 1000000) * 1000000;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= limit);
  return String(value[0] % 1000000).padStart(6, "0");
}

function pakeIdentities(roomId, admissionId, memberId) {
  return [
    utf8.encode(`DawnMesh internet PAKE v1 client\0${state.info.instanceId}\0${roomId}\0${admissionId}\0${memberId}`),
    utf8.encode(`DawnMesh internet PAKE v1 host\0${state.info.instanceId}\0${roomId}`),
  ];
}

async function loadServer() {
  state.info = await api("/api/v1/info");
  if (state.info.protocolVersion !== 1) throw new Error(`不兼容的服务器协议版本：${state.info.protocolVersion}`);
  $("#server-name").textContent = state.info.name || "DawnMesh Server";
  $("#max-participants-input").max = String(state.info.maxRoomParticipants);
  $("#max-participants-input").value = String(Math.min(25, state.info.maxRoomParticipants));
  $("#monitoring-option").hidden = !state.info.adminListeningSupported;
  show($("#lobby-view"));
  await loadRooms();
  window.clearInterval(state.roomsTimer);
  state.roomsTimer = window.setInterval(() => {
    if (!$("#lobby-view").hidden) loadRooms().catch(() => {});
  }, 10000);
}

async function loadRooms() {
  const response = await api("/api/v1/rooms");
  renderRooms(response.rooms || []);
  $("#rooms-updated").textContent = `更新于 ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function hue(value) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return hash % 360;
}

function renderRooms(rooms) {
  const list = $("#room-list");
  list.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "附近还没有公网房间，创建一个开始对讲吧。";
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

function openJoin(room) {
  $("#join-room-id").value = room.id;
  $("#join-room-name").textContent = `加入“${room.name}”`;
  $("#invite-input").value = "";
  $("#join-error").textContent = "";
  $("#join-dialog").showModal();
  $("#invite-input").focus();
}

async function createRoom(form) {
  const button = $("#create-room-button");
  const error = $("#create-error");
  error.textContent = "";
  setBusy(button, true, "正在生成密钥…");
  try {
    const inviteCode = randomInvite();
    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    const inviteScalar = await DawnCrypto.deriveInviteScalar(inviteCode);
    setBusy(button, true, "正在创建…");
    const body = {
      name: $("#room-name-input").value.trim(),
      nickname: state.nickname,
      deviceId: state.deviceId,
      maxParticipants: Number($("#max-participants-input").value),
      hostDisconnectTimeoutMinutes: Number($("#host-timeout-input").value),
    };
    if ($("#allow-monitoring").checked) body.monitoringKey = DawnCrypto.base64Url(roomKey);
    const grant = await api("/api/v1/rooms", { method: "POST", body: JSON.stringify(body) });
    $("#create-dialog").close();
    await enterRoom({ grant, roomKey, inviteCode, inviteScalar });
  } catch (cause) {
    error.textContent = errorText(cause);
  } finally {
    setBusy(button, false);
  }
}

async function completeAdmission(roomId, inviteCode) {
  const admission = await api(`/api/v1/rooms/${encodeURIComponent(roomId)}/admissions`, {
    method: "POST",
    body: JSON.stringify({ nickname: state.nickname, deviceId: state.deviceId }),
  });
  const scalar = await DawnCrypto.deriveInviteScalar(inviteCode);
  const pake = new DawnCrypto.Spake2({ isA: true, passwordScalar: scalar });
  const socket = openEventSocket(admission.eventsUrl, admission.resumeToken);
  await waitForOpen(socket);
  return new Promise((resolve, reject) => {
    let keys = null;
    let settled = false;
    const timer = window.setTimeout(() => finish(new Error("邀请码验证超时")), 20000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      socket.close();
      error ? reject(error) : resolve({ ...value, inviteScalar: scalar });
    };
    socket.addEventListener("message", async (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.admissionId !== admission.admissionId) return;
        if (event.type === "pake_reply") {
          const packet = DawnCrypto.fromBase64(event.body);
          if (packet.length !== 97) throw new Error("邀请码验证响应无效");
          const identities = pakeIdentities(roomId, admission.admissionId, admission.memberId);
          keys = await pake.finish(packet.slice(0, 65), identities[0], identities[1]);
          if (!DawnCrypto.timingSafeEqual(packet.slice(65), keys.confirmB)) throw new Error("邀请码不正确");
          socket.send(JSON.stringify({ type: "pake_confirm", admissionId: admission.admissionId, body: DawnCrypto.base64(keys.confirmA) }));
        } else if (event.type === "pake_key") {
          if (!keys) throw new Error("邀请码验证状态无效");
          const wrappingKey = await DawnCrypto.dawnHkdf(keys.sharedKey, "DawnMesh internet room key wrapping v1");
          const roomKey = await DawnCrypto.aesDecrypt(wrappingKey, DawnCrypto.fromBase64(event.body), utf8.encode(admission.admissionId));
          if (roomKey.length !== 32) throw new Error("房间密钥无效");
          finish(null, { grant: event.connection, roomKey, inviteCode });
        } else if (event.type === "admission_rejected" || event.type === "error") {
          finish(new Error(event.error || "邀请码验证失败"));
        }
      } catch (cause) { finish(cause); }
    });
    socket.addEventListener("close", () => finish(new Error("房主连接已中断")), { once: true });
    socket.addEventListener("error", () => finish(new Error("邀请码验证连接失败")), { once: true });
    socket.send(JSON.stringify({ type: "pake_hello", admissionId: admission.admissionId, body: DawnCrypto.base64(pake.message) }));
  });
}

async function enterRoom({ grant, roomKey, inviteCode, inviteScalar }) {
  window.clearInterval(state.roomsTimer);
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
    audioProfile: navigator.connection?.saveData ? "data" : "clarity",
    speaking: new Set(),
    messages: [],
    hostAdmissions: new Map(),
    chatCipher: await DawnCrypto.ChatCipher.create(roomKey),
    socket: null,
    room: null,
    worker: null,
    leaving: false,
    eventsReconnectTimer: null,
    fullReconnectTimer: null,
    reconnectStarted: 0,
    inviteVisible: false,
    inviteTimer: null,
  };
  $("#audio-profile").value = state.active.audioProfile;
  show($("#room-view"));
  renderRoom();
  try {
    await connectEvents();
    await connectMedia(grant);
  } catch (cause) {
    setRoomStatus("reconnecting", "首次连接未完成，正在自动恢复");
    toast(errorText(cause));
    scheduleFullReconnect();
  }
  await acquireWakeLock();
}

async function connectEvents() {
  const active = state.active;
  if (!active || active.leaving) return;
  if (active.socket) {
    active.socket.intentional = true;
    active.socket.close();
  }
  const socket = openEventSocket(active.grant.eventsUrl, active.resumeToken);
  active.socket = socket;
  socket.addEventListener("message", (message) => handleManagementEvent(JSON.parse(message.data)).catch((cause) => toast(errorText(cause))));
  socket.addEventListener("close", () => {
    if (state.active !== active || active.leaving || socket.intentional) return;
    setRoomStatus("reconnecting", "管理通道中断，正在恢复");
    window.clearTimeout(active.eventsReconnectTimer);
    active.eventsReconnectTimer = window.setTimeout(() => connectEvents().catch(() => scheduleFullReconnect()), 2000);
  });
  await waitForOpen(socket);
}

async function handleManagementEvent(event) {
  const active = state.active;
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
      if (!active.canSpeak) active.ptt = false;
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
    toast("房间已解散");
    await cleanupRoom();
    await loadServer();
  } else if (event.type === "pake_hello" && active.isHost) {
    await hostPakeHello(event);
  } else if (event.type === "pake_confirm" && active.isHost) {
    await hostPakeConfirm(event);
  }
}

async function hostPakeHello(event) {
  const active = state.active;
  const packet = DawnCrypto.fromBase64(event.body);
  if (packet.length !== 65 || active.hostAdmissions.size >= 8) return;
  for (const [id, pending] of active.hostAdmissions) if (Date.now() - pending.created > 30000) active.hostAdmissions.delete(id);
  const pake = new DawnCrypto.Spake2({ isA: false, passwordScalar: active.inviteScalar });
  const identities = pakeIdentities(active.summary.id, event.admissionId, event.memberId);
  const keys = await pake.finish(packet, identities[0], identities[1]);
  active.hostAdmissions.set(event.admissionId, { keys, created: Date.now() });
  sendEvent({ type: "pake_reply", admissionId: event.admissionId, body: DawnCrypto.base64(DawnCrypto.concat(pake.message, keys.confirmB)) });
}

async function hostPakeConfirm(event) {
  const active = state.active;
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

function sendEvent(value) {
  const socket = state.active?.socket;
  if (socket?.readyState !== WebSocket.OPEN) throw new Error("管理通道暂不可用");
  socket.send(JSON.stringify(value));
}

function audioBitrate() {
  return { clarity: 32000, balanced: 24000, data: 12000 }[state.active?.audioProfile] || 24000;
}

function audioOptions() {
  return {
    capture: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true, channelCount: 1, sampleRate: 16000 },
    publish: { audioBitrate: audioBitrate(), dtx: true, red: false, stopMicTrackOnMute: false },
  };
}

async function connectMedia(grant) {
  const active = state.active;
  if (!active || active.leaving) return;
  if (!window.LivekitClient || typeof Worker === "undefined") throw new Error("当前浏览器不支持 WebRTC 端到端加密");
  if (active.room) {
    active.intentionalMediaDisconnects ||= new WeakSet();
    active.intentionalMediaDisconnects.add(active.room);
    await active.room.disconnect().catch(() => {});
  }
  active.worker?.terminate();
  $("#remote-audio").replaceChildren();
  const worker = new Worker("/client/vendor/livekit-client.e2ee.worker.js");
  const keyProvider = new LivekitClient.ExternalE2EEKeyProvider();
  const options = audioOptions();
  const room = new LivekitClient.Room({
    encryption: { keyProvider, worker },
    adaptiveStream: false,
    dynacast: false,
    audioCaptureDefaults: options.capture,
    publishDefaults: options.publish,
  });
  active.room = room;
  active.worker = worker;
  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== LivekitClient.Track.Kind.Audio) return;
    const element = track.attach();
    element.autoplay = true;
    $("#remote-audio").append(element);
    element.play().catch(() => { $("#resume-audio").hidden = false; });
  });
  room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
    for (const element of track.detach()) element.remove();
  });
  room.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
    active.speaking = new Set(speakers.map((participant) => participant.identity));
    renderMembers();
  });
  room.on(LivekitClient.RoomEvent.ParticipantPermissionsChanged, async (_, participant) => {
    if (participant?.identity !== active.memberId) return;
    active.canSpeak = room.localParticipant.permissions?.canPublish ?? active.canSpeak;
    if (!active.canSpeak) active.ptt = false;
    await applyMicrophone(currentMicWanted());
    renderTalkState();
  });
  room.on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, () => {
    $("#resume-audio").hidden = room.canPlaybackAudio;
  });
  room.on(LivekitClient.RoomEvent.Reconnecting, () => setRoomStatus("reconnecting", "媒体连接波动，正在恢复"));
  room.on(LivekitClient.RoomEvent.Reconnected, () => setRoomStatus("connected", "连接安全 · 端到端加密"));
  room.on(LivekitClient.RoomEvent.Disconnected, () => {
    if (active.intentionalMediaDisconnects?.has(room)) return;
    if (state.active === active && !active.leaving) scheduleFullReconnect();
  });
  room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic === "dawnmesh.chat.v1" && participant) receiveChat(payload, participant).catch(() => {});
  });
  await keyProvider.setKey(DawnCrypto.base64Url(active.roomKey));
  await room.setE2EEEnabled(true);
  await room.connect(grant.livekitUrl, grant.livekitToken, { autoSubscribe: true });
  sendEvent({ type: "media_ready", memberId: active.memberId });
  await applyMicrophone(currentMicWanted());
  setRoomStatus("connected", "连接安全 · 端到端加密");
}

function currentMicWanted() {
  const active = state.active;
  return Boolean(active && active.canSpeak && !active.muted && (active.voiceMode === "auto" || active.ptt));
}

async function applyMicrophone(enabled) {
  const active = state.active;
  if (!active?.room || active.room.state !== "connected") return;
  try {
    const options = audioOptions();
    await active.room.localParticipant.setMicrophoneEnabled(enabled, options.capture, options.publish);
    if (enabled) await applyAudioBitrate();
  } catch (cause) {
    if (enabled) toast(errorText(cause));
  }
  renderTalkState();
}

async function applyAudioBitrate() {
  const active = state.active;
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

function scheduleFullReconnect() {
  const active = state.active;
  if (!active || active.leaving || active.fullReconnectTimer) return;
  if (!active.reconnectStarted) active.reconnectStarted = Date.now();
  if (Date.now() - active.reconnectStarted > 10 * 60 * 1000) {
    setRoomStatus("failed", "恢复窗口已结束，请重新加入");
    return;
  }
  setRoomStatus("reconnecting", "连接中断，正在自动恢复");
  active.fullReconnectTimer = window.setTimeout(async () => {
    active.fullReconnectTimer = null;
    try {
      const grant = await api(`/api/v1/rooms/${encodeURIComponent(active.summary.id)}/resume`, {
        method: "POST",
        body: JSON.stringify({ memberId: active.memberId, resumeToken: active.resumeToken }),
      });
      active.grant = grant;
      active.resumeToken = grant.resumeToken;
      await connectEvents();
      await connectMedia(grant);
      active.reconnectStarted = 0;
    } catch (_) {
      scheduleFullReconnect();
    }
  }, 2000);
}

function setRoomStatus(mode, label) {
  const element = $("#room-connection-state");
  element.className = `room-status ${mode}`;
  element.lastChild.textContent = label;
}

function revealInvite() {
  const active = state.active;
  if (!active?.isHost) return;
  active.inviteVisible = true;
  window.clearTimeout(active.inviteTimer);
  active.inviteTimer = window.setTimeout(() => hideInvite(), 10000);
  renderInvite();
}

function hideInvite(remove = false) {
  const active = state.active;
  if (!active) return;
  active.inviteVisible = false;
  window.clearTimeout(active.inviteTimer);
  if (remove) active.inviteTimer = null;
  renderInvite();
}

function renderInvite() {
  const active = state.active;
  const card = $("#invite-card");
  card.hidden = !active?.isHost;
  if (!active?.isHost) return;
  $("#invite-code").textContent = active.inviteVisible ? active.inviteCode : "••••••";
  $("#toggle-invite").textContent = active.inviteVisible ? "◉" : "◎";
  $("#toggle-invite").setAttribute("aria-label", active.inviteVisible ? "隐藏邀请码" : "显示邀请码");
}

function initials(nickname) {
  const clean = (nickname || "?").split("#")[0].trim();
  return Array.from(clean).slice(0, 2).join("").toUpperCase() || "?";
}

function renderMembers() {
  const active = state.active;
  if (!active) return;
  const grid = $("#member-grid");
  grid.replaceChildren();
  $("#member-count").textContent = `${active.members.length} 人`;
  for (const member of active.members) {
    const card = document.createElement("article");
    card.className = `member-card${active.speaking.has(member.id) ? " speaking" : ""}`;
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.style.setProperty("--avatar-hue", hue(member.id || member.nickname));
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

function actionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await handler(); } catch (cause) { toast(errorText(cause)); } finally { button.disabled = false; }
  });
  return button;
}

async function setMemberVoice(member) {
  const active = state.active;
  await api(`/api/v1/rooms/${encodeURIComponent(active.summary.id)}/members/${encodeURIComponent(member.id)}/voice-policy`, {
    method: "PUT", sessionToken: active.resumeToken, body: JSON.stringify({ canSpeak: !member.canSpeak }),
  });
}

async function transferHost(member) {
  if (!confirm(`把房主转让给“${member.nickname}”吗？`)) return;
  const active = state.active;
  await api(`/api/v1/rooms/${encodeURIComponent(active.summary.id)}/handover`, {
    method: "POST", sessionToken: active.resumeToken, body: JSON.stringify({ memberId: member.id }),
  });
}

function renderTalkState() {
  const active = state.active;
  if (!active) return;
  const button = $("#talk-button");
  const enabled = currentMicWanted();
  button.classList.toggle("active", enabled);
  button.classList.toggle("disabled", !active.canSpeak);
  button.disabled = !active.canSpeak;
  if (!active.canSpeak) {
    $("#talk-label").textContent = "已被房主封麦";
    $("#talk-hint").textContent = "等待房主恢复发言";
  } else if (active.voiceMode === "auto") {
    $("#talk-label").textContent = active.muted ? "自动通话已静音" : "自动通话中";
    $("#talk-hint").textContent = active.muted ? "点击下方取消静音" : "静音段使用 DTX 省流";
  } else {
    $("#talk-label").textContent = active.ptt ? "正在说话" : "按住说话";
    $("#talk-hint").textContent = active.muted ? "本机已静音" : "松开即停止发送";
  }
  $("#mute-button").classList.toggle("active", active.muted);
  $("#mute-button").querySelector("small").textContent = active.muted ? "取消静音" : "静音";
  $("#call-notice").textContent = active.summary.adminListening ? "服务器管理员正在实时收听此房间" : "";
}

function renderRoom() {
  const active = state.active;
  if (!active) return;
  $("#active-room-name").textContent = active.summary.name;
  $("#rename-room").hidden = !active.isHost;
  $("#end-room").hidden = !active.isHost;
  for (const button of $("#voice-mode").querySelectorAll("button")) button.classList.toggle("active", button.dataset.mode === active.voiceMode);
  renderInvite();
  renderMembers();
  renderTalkState();
  renderChat();
}

async function receiveChat(packet, participant) {
  const active = state.active;
  if (!active || packet.length < 29) return;
  const senderId = participant.identity;
  const clear = await active.chatCipher.decrypt(packet, utf8.encode(`dawnmesh.chat.v1\0${senderId}`));
  const message = JSON.parse(decoder.decode(clear));
  if (message.senderId !== senderId || typeof message.text !== "string" || utf8.encode(message.text).length > 1000) return;
  active.messages.push({ ...message, mine: senderId === active.memberId });
  if (active.messages.length > 100) active.messages.shift();
  renderChat();
}

async function sendChat(text) {
  const active = state.active;
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
  await active.room.localParticipant.publishData(packet, { reliable: true, topic: "dawnmesh.chat.v1" });
  active.messages.push({ ...message, mine: true });
  renderChat();
}

function renderChat() {
  const active = state.active;
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
  const active = state.active;
  if (!active) return;
  active.leaving = true;
  window.clearTimeout(active.inviteTimer);
  window.clearTimeout(active.eventsReconnectTimer);
  window.clearTimeout(active.fullReconnectTimer);
  if (active.socket) { active.socket.intentional = true; active.socket.close(); }
  await active.room?.disconnect().catch(() => {});
  active.worker?.terminate();
  $("#remote-audio").replaceChildren();
  state.active = null;
  await releaseWakeLock();
}

async function leaveRoom(endRoom = false) {
  const active = state.active;
  if (!active) return;
  if (endRoom && !confirm("确定立即解散房间吗？所有成员都会断开。")) return;
  try {
    const path = endRoom
      ? `/api/v1/rooms/${encodeURIComponent(active.summary.id)}`
      : `/api/v1/rooms/${encodeURIComponent(active.summary.id)}/members/${encodeURIComponent(active.memberId)}`;
    await api(path, { method: "DELETE", sessionToken: active.resumeToken, body: JSON.stringify({}) });
  } catch (cause) {
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
  } catch (cause) { error.textContent = errorText(cause); } finally { setBusy(button, false); }
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
  $("#create-dialog").showModal();
});
$("#create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#create-dialog").close(); return; }
  if (event.currentTarget.reportValidity()) createRoom(event.currentTarget);
});
$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#join-dialog").close(); return; }
  if (!event.currentTarget.reportValidity()) return;
  const button = $("#join-room-button");
  const error = $("#join-error");
  error.textContent = "";
  setBusy(button, true, "正在验证…");
  try {
    const result = await completeAdmission($("#join-room-id").value, $("#invite-input").value);
    $("#join-dialog").close();
    await enterRoom(result);
  } catch (cause) { error.textContent = errorText(cause); } finally { setBusy(button, false); }
});
$("#leave-room").addEventListener("click", () => leaveRoom(false));
$("#end-room").addEventListener("click", () => leaveRoom(true));
$("#toggle-invite").addEventListener("click", () => state.active?.inviteVisible ? hideInvite() : revealInvite());
$("#resume-audio").addEventListener("click", async () => {
  await state.active?.room?.startAudio();
  for (const audio of $("#remote-audio").querySelectorAll("audio")) await audio.play().catch(() => {});
  $("#resume-audio").hidden = true;
});
$("#voice-mode").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button || !state.active) return;
  state.active.voiceMode = button.dataset.mode;
  state.active.ptt = false;
  await applyMicrophone(currentMicWanted());
  renderRoom();
});
$("#mute-button").addEventListener("click", async () => {
  if (!state.active) return;
  state.active.muted = !state.active.muted;
  if (state.active.muted) state.active.ptt = false;
  await applyMicrophone(currentMicWanted());
});
$("#audio-profile").addEventListener("change", async (event) => {
  if (!state.active) return;
  state.active.audioProfile = event.target.value;
  await applyAudioBitrate();
  toast(`已切换到${event.target.selectedOptions[0].textContent.split(" · ")[0]}音质`);
});

const talk = $("#talk-button");
async function setPTT(pressed) {
  const active = state.active;
  if (!active || active.voiceMode !== "ptt" || active.muted || !active.canSpeak || active.ptt === pressed) return;
  active.ptt = pressed;
  await applyMicrophone(pressed);
}
talk.addEventListener("pointerdown", (event) => { event.preventDefault(); talk.setPointerCapture(event.pointerId); setPTT(true); });
talk.addEventListener("pointerup", (event) => { event.preventDefault(); setPTT(false); });
talk.addEventListener("pointercancel", () => setPTT(false));
talk.addEventListener("lostpointercapture", () => setPTT(false));
talk.addEventListener("keydown", (event) => { if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); setPTT(true); } });
talk.addEventListener("keyup", (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setPTT(false); } });

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const value = input.value;
  input.value = "";
  try { await sendChat(value); } catch (cause) { input.value = value; toast(errorText(cause)); }
});
$("#rename-room").addEventListener("click", () => {
  $("#rename-input").value = state.active?.summary.name || "";
  $("#rename-error").textContent = "";
  $("#rename-dialog").showModal();
});
$("#rename-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#rename-dialog").close(); return; }
  const active = state.active;
  if (!active || !event.currentTarget.reportValidity()) return;
  try {
    await api(`/api/v1/rooms/${encodeURIComponent(active.summary.id)}`, {
      method: "PATCH", sessionToken: active.resumeToken, body: JSON.stringify({ name: $("#rename-input").value.trim() }),
    });
    $("#rename-dialog").close();
  } catch (cause) { $("#rename-error").textContent = errorText(cause); }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    setPTT(false);
    hideInvite();
  } else if (state.active) {
    acquireWakeLock();
  }
});
window.addEventListener("pagehide", () => { setPTT(false); releaseWakeLock(); });

if (!window.isSecureContext) {
  $("#setup-error").textContent = "网页对讲需要 HTTPS 安全上下文才能使用麦克风和端到端加密。";
  $("#connect-server-button").disabled = true;
}
