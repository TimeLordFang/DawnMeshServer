import type { Page } from '@playwright/test';
interface SetupRoomOptions { isHost?: boolean }
export async function setupRoom(page: Page, options: SetupRoomOptions = {}) {
  let sendEvent: ((event: unknown) => void) | undefined;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const isHost = options.isHost ?? true;
    const summary = { id: 'room-one', name: '山海骑行小队', hostNickname: '林间', memberCount: 3, maxParticipants: 25, isHost, adminListening: false };
    const grant = { room: summary, memberId: 'me', resumeToken: 'test-session', eventsUrl: '/api/v1/events', livekitUrl: 'wss://test.invalid', livekitToken: 'test' };
    let result: unknown = {};
    if (path.endsWith('/info')) result = { protocolVersion: 1, instanceId: 'test', name: '曙光之声', maxRoomParticipants: 25, adminListeningSupported: true };
    if (path.endsWith('/rooms')) result = route.request().method() === 'POST' ? grant : { rooms: [summary] };
    if (path.endsWith('/media-grant')) result = grant;
    if (path.endsWith('/overview')) result = {
      instance: { name: '曙光之声控制台', maximumRooms: 1000, uptimeMs: 19000000 }, totals: { rooms: 1, connectedMembers: 3, members: 3 }, now: new Date().toISOString(),
      rooms: [{ ...summary, createdAt: new Date().toISOString(), members: [{ id: 'me', nickname: '林间', canSpeak: true, isHost: true, connected: true }], adminListeningAvailable: true }],
    };
    if (path.endsWith('/listen')) result = { listenerId: 'listener', e2eeKey: 'AA==', livekitUrl: 'wss://test.invalid', livekitToken: 'test' };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket('**/api/v1/events', ws => {
    sendEvent = event => ws.send(JSON.stringify(event));
    setTimeout(() => ws.send(JSON.stringify({ type: 'snapshot', hostMemberId: options.isHost === false ? 'river' : 'me', canSpeak: true, members: [
      { id: 'me', nickname: '林间', canSpeak: true, isHost: options.isHost !== false, connected: true },
      { id: 'river', nickname: '小河', canSpeak: true, isHost: options.isHost === false, connected: true },
      { id: 'mountain', nickname: '远山', canSpeak: true, connected: true },
    ] })), 30);
  });
  // Mock only the media signalling SDK. Capture uses the browser's real
  // getUserMedia implementation with Chrome's synthetic microphone device.
  await page.route(/\/node_modules\/\.vite\/deps\/livekit-client\.js/, route => route.fulfill({
    contentType: 'text/javascript',
    body: `
      export const Track = { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } };
      export const RoomEvent = new Proxy({}, { get: (_, key) => key });
      export const isE2EESupported = () => true;
      export class ExternalE2EEKeyProvider { async setKey(key) { window.__mediaKey = key; } }
      export class LocalAudioTrack {
        constructor(track) { this.mediaStreamTrack = track; window.__track = this; }
        async mute() { this.mediaStreamTrack.enabled = false; }
        async unmute() { await new Promise(r => setTimeout(r, 40)); this.mediaStreamTrack.enabled = true; }
        stop() { this.mediaStreamTrack.stop(); }
      }
      export class Room {
        state = 'disconnected'; canPlaybackAudio = false; handlers = {};
        constructor(options) {
          window.__room = this;
          window.__roomOptions = options;
          this.localParticipant = {
            permissions: { canPublish: true }, audioTrackPublications: new Map(),
            publishTrack: async track => { window.__publishedMuted = !track.mediaStreamTrack.enabled; },
            unpublishTrack: async () => {}, publishData: async () => {},
          };
        }
        on(name, fn) { (this.handlers[name] ||= []).push(fn); return this; }
        emit(name, ...args) { for (const fn of this.handlers[name] || []) fn(...args); }
        async setE2EEEnabled() {}
        async connect() { this.state = 'connected'; }
        async disconnect() { this.state = 'disconnected'; }
        async startAudio() { this.canPlaybackAudio = true; this.emit('AudioPlaybackStatusChanged'); }
        async switchActiveDevice() { return true; }
      }
    `,
  }));
  return {
    sendManagementEvent(event: unknown) {
      if (!sendEvent) throw new Error('management websocket is not connected');
      sendEvent(event);
    },
  };
}
export async function enterRoom(page: Page, options: SetupRoomOptions = {}) {
  const fixture = await setupRoom(page, options);
  await page.goto('/ui/client/');
  await page.getByLabel('昵称', { exact: true }).fill('林间');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByRole('button', { name: '＋ 创建房间' }).click();
  await page.locator('#room-name-input').fill('山海骑行小队');
  await page.locator('#create-room-button').click();
  await page.locator('#room-connection-state.connected').waitFor();
  return fixture;
}
