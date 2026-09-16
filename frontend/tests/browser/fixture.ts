import type { Page } from '@playwright/test';
export async function setupRoom(page: Page) {
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const summary = { id: 'room-one', name: '山海骑行小队', hostNickname: '林间', memberCount: 3, maxParticipants: 25, isHost: true, adminListening: false };
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
    setTimeout(() => ws.send(JSON.stringify({ type: 'snapshot', hostMemberId: 'me', canSpeak: true, members: [
      { id: 'me', nickname: '林间', canSpeak: true, isHost: true, connected: true },
      { id: 'river', nickname: '小河', canSpeak: true, connected: true },
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
      export class ExternalE2EEKeyProvider { async setKey(key) { window.__mediaKey = Array.from(new Uint8Array(key)); } }
      export class LocalAudioTrack {
        constructor(track) { this.mediaStreamTrack = track; window.__track = this; }
        async mute() { this.mediaStreamTrack.enabled = false; }
        async unmute() { await new Promise(r => setTimeout(r, 40)); this.mediaStreamTrack.enabled = true; }
        stop() { this.mediaStreamTrack.stop(); }
      }
      export class Room {
        state = 'disconnected'; canPlaybackAudio = false; handlers = {};
        constructor() {
          window.__room = this;
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
}
export async function enterRoom(page: Page) {
  await setupRoom(page);
  await page.goto('/ui/client/');
  await page.getByLabel('昵称', { exact: true }).fill('林间');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await page.getByRole('button', { name: '＋ 创建房间' }).click();
  await page.locator('#room-name-input').fill('山海骑行小队');
  await page.locator('#create-room-button').click();
  await page.locator('#room-connection-state.connected').waitFor();
}
