"use strict";

const storageKey = "dawnmesh-admin-token";
const loginView = document.querySelector("#login-view");
const dashboardView = document.querySelector("#dashboard-view");
const loginForm = document.querySelector("#login-form");
const tokenInput = document.querySelector("#token-input");
const loginButton = document.querySelector("#login-button");
const loginError = document.querySelector("#login-error");
const toggleToken = document.querySelector("#toggle-token");
const logoutButton = document.querySelector("#logout-button");
const refreshButton = document.querySelector("#refresh-button");
const connectionState = document.querySelector("#connection-state");
const instanceName = document.querySelector("#instance-name");
const stats = document.querySelector("#stats");
const rooms = document.querySelector("#rooms");
const lastUpdated = document.querySelector("#last-updated");
const notice = document.querySelector("#notice");
const listeningPanel = document.querySelector("#listening-panel");
const listeningTitle = document.querySelector("#listening-title");
const listeningStatus = document.querySelector("#listening-status");
const monitorAudio = document.querySelector("#monitor-audio");
const resumeAudioButton = document.querySelector("#resume-audio-button");
const stopListeningButton = document.querySelector("#stop-listening-button");

let adminToken = sessionStorage.getItem(storageKey) || "";
let refreshTimer = null;
let loading = false;
let activeListener = null;
let listenerHeartbeat = null;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(className, text, handler) {
  const element = node("button", className, text);
  element.type = "button";
  element.addEventListener("click", handler);
  return element;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${adminToken}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(payload.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setConnection(mode, text) {
  connectionState.className = `connection-pill ${mode}`;
  connectionState.lastChild.textContent = text;
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = !message;
}

async function resumeMonitorAudio() {
  const elements = monitorAudio.querySelectorAll("audio");
  const results = await Promise.allSettled(Array.from(elements, (element) => element.play()));
  const blocked = results.some((result) => result.status === "rejected");
  listeningStatus.textContent = blocked ? "浏览器阻止了自动播放，请再次点击启用声音。" : "正在实时收听端到端加密音频";
}

async function stopListening({ notifyServer = true } = {}) {
  const current = activeListener;
  activeListener = null;
  window.clearInterval(listenerHeartbeat);
  listenerHeartbeat = null;
  if (!current) return;
  try {
    await current.room.disconnect();
  } catch (_) {}
  current.worker.terminate();
  monitorAudio.replaceChildren();
  listeningPanel.hidden = true;
  if (notifyServer) {
    try {
      await api(`/api/v1/admin/listeners/${encodeURIComponent(current.id)}`, { method: "DELETE" });
    } catch (error) {
      if (error.status !== 404) showNotice(error.message);
    }
  }
  await loadOverview().catch(() => {});
}

async function startListening(room) {
  if (!window.LivekitClient || typeof Worker === "undefined") {
    throw new Error("当前浏览器不支持实时收听所需的 WebRTC/E2EE 能力");
  }
  if (activeListener) await stopListening();
  const grant = await api(`/api/v1/admin/rooms/${encodeURIComponent(room.id)}/listen`, { method: "POST" });
  const worker = new Worker("/admin/vendor/livekit-client.e2ee.worker.js");
  const keyProvider = new LivekitClient.ExternalE2EEKeyProvider();
  const liveRoom = new LivekitClient.Room({
    encryption: { keyProvider, worker },
    adaptiveStream: false,
    dynacast: false,
  });
  activeListener = { id: grant.listenerId, roomId: room.id, room: liveRoom, worker };
  listeningTitle.textContent = `正在收听“${room.name}”`;
  listeningStatus.textContent = "建立端到端加密的只听连接…";
  listeningPanel.hidden = false;
  liveRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== LivekitClient.Track.Kind.Audio) return;
    const element = track.attach();
    element.autoplay = true;
    element.controls = false;
    monitorAudio.append(element);
    resumeMonitorAudio().catch(() => {});
  });
  liveRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
    for (const element of track.detach()) element.remove();
  });
  liveRoom.on(LivekitClient.RoomEvent.Reconnecting, () => {
    listeningStatus.textContent = "媒体连接波动，正在自动恢复…";
  });
  liveRoom.on(LivekitClient.RoomEvent.Reconnected, () => {
    listeningStatus.textContent = "正在实时收听端到端加密音频";
  });
  try {
    // Keep this as a string. DawnMesh's Flutter client also supplies the
    // Base64URL room key as a passphrase; LiveKit then uses the same PBKDF2
    // path across SDKs. Passing an ArrayBuffer would select HKDF in the web
    // SDK and produce an incompatible media key.
    await keyProvider.setKey(grant.e2eeKey);
    await liveRoom.setE2EEEnabled(true);
    await liveRoom.connect(grant.livekitUrl, grant.livekitToken, { autoSubscribe: true });
    listeningStatus.textContent = "连接成功，等待房间语音…";
    listenerHeartbeat = window.setInterval(async () => {
      if (!activeListener) return;
      try {
        await api(`/api/v1/admin/listeners/${encodeURIComponent(activeListener.id)}`, { method: "PUT" });
      } catch (error) {
        showNotice(`实时收听已结束：${error.message}`);
        await stopListening({ notifyServer: false });
      }
    }, 10000);
    await loadOverview();
  } catch (error) {
    await stopListening();
    throw error;
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function renderStats(data) {
  const items = [
    ["房间", `${data.totals.rooms} / ${data.instance.maximumRooms}`],
    ["在线成员", `${data.totals.connectedMembers}`],
    ["保留成员", `${data.totals.members}`],
    ["运行时间", formatDuration(data.instance.uptimeMs)],
  ];
  stats.replaceChildren(...items.map(([label, value]) => {
    const card = node("article", "stat-card");
    card.append(node("p", "stat-label", label), node("p", "stat-value", value));
    return card;
  }));
}

function memberRow(room, member) {
  const row = node("div", "member-row");
  const identity = node("div", "member-identity");
  const avatar = node("div", "avatar", Array.from(member.nickname || "?")[0] || "?");
  const details = node("div");
  const name = node("div", "member-name", member.nickname || "未命名成员");
  const states = [member.connected ? "在线" : "离线"];
  if (!member.connected && member.reconnectDeadline) states.push(`保留至 ${formatTime(member.reconnectDeadline)}`);
  if (member.isHost) states.push("房主");
  const subtitle = node("div", "member-subtitle", states.join(" · "));
  details.append(name, subtitle);
  identity.append(avatar, details);
  row.append(identity);

  if (member.isHost) {
    row.append(node("span", "badge host", "房主"));
  } else {
    const action = button(
      member.canSpeak ? "member-action" : "member-action allow",
      member.canSpeak ? "关闭麦克风" : "恢复麦克风",
      async () => {
        action.disabled = true;
        try {
          const result = await api(`/api/v1/admin/rooms/${encodeURIComponent(room.id)}/members/${encodeURIComponent(member.id)}/voice-policy`, {
            method: "PUT",
            body: JSON.stringify({ canSpeak: !member.canSpeak }),
          });
          showNotice(result.mediaUpdatePending ? "策略已保存；媒体服务暂时不可达，将在成员重连时重新应用。" : "成员发言权限已更新。");
          await loadOverview();
        } catch (error) {
          showNotice(error.message);
        } finally {
          action.disabled = false;
        }
      },
    );
    row.append(action);
  }
  return row;
}

function roomCard(room) {
  const card = node("article", "room-card");
  const heading = node("div", "room-heading");
  const titleArea = node("div");
  const title = node("div", "room-title");
  title.append(node("h3", "", room.name));
  const online = room.members.filter((member) => member.connected).length;
  title.append(node("span", online ? "badge good" : "badge warn", online ? `${online} 人在线` : "当前空房"));
  if (room.pendingAdmissions) title.append(node("span", "badge warn", `${room.pendingAdmissions} 人验证中`));
  if (room.activeAdminListeners) title.append(node("span", "badge warn", `${room.activeAdminListeners} 个管理员收听连接`));
  titleArea.append(title, node("p", "room-meta", `房主：${room.hostNickname} · ${room.members.length}/${room.maxParticipants} 人 · 创建于 ${formatTime(room.createdAt)}`));

  const actions = node("div", "room-actions");
  if (room.adminListeningAvailable) {
    const listeningHere = activeListener?.roomId === room.id;
    actions.append(button(
      listeningHere ? "danger-button" : "primary-button",
      listeningHere ? "停止收听" : "实时收听",
      async () => {
        try {
          if (listeningHere) {
            await stopListening();
          } else {
            await startListening(room);
          }
        } catch (error) {
          showNotice(`无法开始收听：${error.message}`);
        }
      },
    ));
  }
  actions.append(
    button("secondary-button", "修改名称", async () => {
      const nextName = window.prompt("新的房间名称", room.name);
      if (!nextName || nextName.trim() === room.name) return;
      try {
        await api(`/api/v1/admin/rooms/${encodeURIComponent(room.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ name: nextName.trim() }),
        });
        showNotice("房间名称已更新。");
        await loadOverview();
      } catch (error) {
        showNotice(error.message);
      }
    }),
    button("danger-button", "解散房间", async () => {
      if (!window.confirm(`确定解散“${room.name}”吗？所有成员会立即离开。`)) return;
      try {
        await api(`/api/v1/admin/rooms/${encodeURIComponent(room.id)}`, { method: "DELETE" });
        showNotice("房间已解散。");
        await loadOverview();
      } catch (error) {
        showNotice(error.message);
      }
    }),
  );
  heading.append(titleArea, actions);
  card.append(heading);

  if (room.hostReconnectDeadline) {
    card.append(node("p", "notice", `房主离线，等待恢复至 ${formatTime(room.hostReconnectDeadline)}（上限 ${room.hostDisconnectTimeoutMinutes} 分钟）`));
  } else if (room.emptyDeadline) {
    card.append(node("p", "notice", `空房保留至 ${formatTime(room.emptyDeadline)}`));
  }

  const memberList = node("div", "members");
  if (room.members.length) {
    memberList.append(...room.members.map((member) => memberRow(room, member)));
  } else {
    memberList.append(node("div", "empty-state", "房间中没有保留成员"));
  }
  card.append(memberList);
  return card;
}

function renderRooms(data) {
  if (!data.rooms.length) {
    const empty = node("div", "empty-state");
    empty.append(node("span", "empty-icon", "☼"), node("p", "", "当前没有公网对讲房间"));
    rooms.replaceChildren(empty);
    return;
  }
  rooms.replaceChildren(...data.rooms.map(roomCard));
}

async function loadOverview() {
  if (!adminToken || loading) return;
  loading = true;
  refreshButton.disabled = true;
  setConnection("", "正在连接");
  try {
    const data = await api("/api/v1/admin/overview");
    instanceName.textContent = data.instance.name || "DawnMesh 管理后台";
    renderStats(data);
    renderRooms(data);
    lastUpdated.textContent = `更新于 ${formatTime(data.now)}`;
    setConnection("online", "服务正常");
    loginView.hidden = true;
    dashboardView.hidden = false;
    loginError.textContent = "";
  } catch (error) {
    setConnection("offline", "连接失败");
    if (error.status === 401 || error.status === 429 || error.status === 503) {
      dashboardView.hidden = true;
      loginView.hidden = false;
      loginError.textContent = error.message;
      if (error.status === 401) sessionStorage.removeItem(storageKey);
    } else {
      showNotice(error.message);
    }
    throw error;
  } finally {
    loading = false;
    refreshButton.disabled = false;
  }
}

function startRefresh() {
  window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => {
    if (!document.hidden) loadOverview().catch(() => {});
  }, 10000);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminToken = tokenInput.value.trim();
  if (!adminToken) return;
  loginButton.disabled = true;
  loginError.textContent = "";
  sessionStorage.setItem(storageKey, adminToken);
  try {
    await loadOverview();
    tokenInput.value = "";
    startRefresh();
  } catch (_) {
    // loadOverview presents the server error in the login view.
  } finally {
    loginButton.disabled = false;
  }
});

toggleToken.addEventListener("click", () => {
  const showing = tokenInput.type === "text";
  tokenInput.type = showing ? "password" : "text";
  toggleToken.textContent = showing ? "显示" : "隐藏";
  toggleToken.setAttribute("aria-label", showing ? "显示凭证" : "隐藏凭证");
});

refreshButton.addEventListener("click", () => loadOverview().catch(() => {}));
resumeAudioButton.addEventListener("click", () => resumeMonitorAudio().catch(() => {}));
stopListeningButton.addEventListener("click", () => stopListening().catch(() => {}));
logoutButton.addEventListener("click", async () => {
  await stopListening();
  sessionStorage.removeItem(storageKey);
  adminToken = "";
  window.clearInterval(refreshTimer);
  dashboardView.hidden = true;
  loginView.hidden = false;
  tokenInput.focus();
});

window.addEventListener("beforeunload", () => {
  if (!activeListener) return;
  fetch(`/api/v1/admin/listeners/${encodeURIComponent(activeListener.id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
    keepalive: true,
  });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && adminToken) loadOverview().catch(() => {});
});

if (adminToken) {
  loadOverview().then(startRefresh).catch(() => {});
} else {
  tokenInput.focus();
}
