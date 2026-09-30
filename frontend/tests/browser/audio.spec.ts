import { test, expect } from '@playwright/test';
import { enterRoom, setupRoom } from './fixture';

test('space transmits only while held; text input and dialogs keep normal keyboard behavior', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await enterRoom(page);
  await page.locator('#enable-audio-devices').click();
  await expect(page.locator('#audio-device-title')).toHaveText('麦克风已就绪');
  await expect.poll(() => page.evaluate(() => (window as any).__publishedMuted)).toBe(true);
  await page.locator('#active-room-name').click();
  await page.keyboard.down('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(true);
  expect(await page.evaluate(() => {
    const repeat = new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat: true, bubbles: true, cancelable: true });
    document.dispatchEvent(repeat);
    return repeat.defaultPrevented;
  })).toBe(true);
  await page.keyboard.up('Space');
  await expect(page.locator('#talk-label')).toHaveText('正在收尾');
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(false);
  await page.locator('#chat-input').fill('同行');
  await page.keyboard.press('Space');
  await expect(page.locator('#chat-input')).toHaveValue('同行 ');
  await page.locator('#rename-room').click();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(false);
  await page.keyboard.press('Escape');
  await page.locator('#active-room-name').click();
  await page.keyboard.down('Space');
  await page.waitForTimeout(80);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(false);
  await page.keyboard.up('Space');
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/dawnmesh-room-desktop.png', fullPage: true });
});

test('pressing again during the 500ms tail window cancels the pending microphone mute', async ({ page }) => {
  await enterRoom(page);
  await page.locator('#enable-audio-devices').click();
  await expect(page.locator('#audio-device-title')).toHaveText('麦克风已就绪');
  await page.locator('#active-room-name').click();
  await page.keyboard.down('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(true);
  await page.keyboard.up('Space');
  await expect(page.locator('#talk-label')).toHaveText('正在收尾');
  await page.keyboard.down('Space');
  await expect(page.locator('#talk-label')).toHaveText('正在说话');
  await page.waitForTimeout(550);
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(true);
  await page.keyboard.up('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(false);
});

test('empty dissolved room returns to the lobby immediately', async ({ page }) => {
  const fixture = await enterRoom(page, { isHost: false });
  fixture.sendManagementEvent({ type: 'room_ended' });
  await expect(page.locator('#lobby-view')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('#room-view')).toBeHidden();
});

test('dissolved room with text stays available until exit', async ({ page }) => {
  const fixture = await enterRoom(page, { isHost: false });
  await page.locator('#chat-input').fill('需要保留的文本');
  await page.locator('#chat-form button[type=submit]').click();
  await expect(page.locator('#chat-list')).toContainText('需要保留的文本');
  fixture.sendManagementEvent({ type: 'room_ended' });
  await expect(page.locator('#toast')).toHaveText('房间已被群主解散，消息保留到退出房间');
  await page.waitForTimeout(10500);
  await expect(page.locator('#room-view')).toBeVisible();
  await expect(page.locator('#lobby-view')).toBeHidden();
});

test('first press released before permission resolves stays silent and leaving stops capture', async ({ page }) => {
  await enterRoom(page);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await original(options);
      await new Promise(resolve => setTimeout(resolve, 250));
      return stream;
    };
  });
  await page.locator('#active-room-name').click();
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  await expect(page.locator('#audio-device-title')).toHaveText('麦克风已就绪');
  expect(await page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(false);
  expect(await page.evaluate(() => (window as any).__publishedMuted)).toBe(true);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#leave-room').click();
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.readyState)).toBe('ended');
});

test('denied microphone still allows listening and has a retry path', async ({ page }) => {
  await enterRoom(page);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
  await page.locator('#enable-listening').click();
  await expect(page.locator('#listening-title')).toHaveText('收听已启用');
  await page.locator('#enable-audio-devices').click();
  await expect(page.locator('#audio-device-status')).toContainText('麦克风权限');
  await expect(page.locator('#enable-audio-devices')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__room.canPlaybackAudio)).toBe(true);
});

test('computer with speakers and no microphone can activate listening', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: async () => [{ deviceId: 'speaker', groupId: 'output', kind: 'audiooutput', label: 'Built-in Output', toJSON() { return this; } }],
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => { throw new DOMException('no microphone', 'NotFoundError'); },
    });
  });
  await enterRoom(page);
  await expect(page.locator('#audio-device-title')).toHaveText('未检测到麦克风');
  await expect(page.locator('#audio-device-status')).toContainText('仍可正常收听');
  await page.locator('#enable-listening').click();
  await expect(page.locator('#listening-title')).toHaveText('收听已启用');
  await expect(page.locator('#audio-output-device')).toHaveValue('speaker');
});

test('mobile room and setup fit without horizontal scrolling; admin loads', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterRoom(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/dawnmesh-room-mobile.png', fullPage: true });
  await page.goto('/ui/client/');
  await page.screenshot({ path: '/tmp/dawnmesh-setup-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/dawnmesh-setup-desktop.png', fullPage: true });
  await page.goto('/ui/admin/');
  await page.getByLabel('管理员凭证', { exact: true }).fill('test');
  await page.getByRole('button', { name: '进入后台' }).click();
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await page.getByRole('button', { name: '实时收听', exact: true }).click();
  await page.getByRole('button', { name: '启用声音' }).click();
  expect(await page.evaluate(() => (window as any).__room.canPlaybackAudio)).toBe(true);
  await page.screenshot({ path: '/tmp/dawnmesh-admin-desktop.png', fullPage: true });
});

test('pointer cancellation and permission revocation close the microphone immediately', async ({ page }) => {
  await enterRoom(page);
  await page.locator('#enable-audio-devices').click();
  await expect(page.locator('#audio-device-title')).toHaveText('麦克风已就绪');
  const talk = page.locator('#talk-button');
  await talk.hover();
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(true);
  await talk.dispatchEvent('pointercancel', { pointerId: 1 });
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(false);
  await page.mouse.up();
  await talk.hover();
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(true);
  await page.mouse.up();
  await expect(page.locator('#talk-label')).toHaveText('正在收尾');
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(false);
  await page.locator('#active-room-name').click();
  await page.keyboard.down('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(true);
  await page.evaluate(() => {
    const room = (window as any).__room;
    room.localParticipant.permissions.canPublish = false;
    room.emit('ParticipantPermissionsChanged', {}, { identity: 'me' });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.enabled)).toBe(false);
  await expect(talk).toBeDisabled();
  await page.keyboard.up('Space');
});

test('permission completing after leave releases the acquired hardware', async ({ page }) => {
  await enterRoom(page);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const stream = await original(options);
      (window as any).__pendingCapture = stream;
      await new Promise(resolve => setTimeout(resolve, 500));
      return stream;
    };
  });
  await page.locator('#enable-audio-devices').click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__pendingCapture))).toBe(true);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#leave-room').click();
  await expect.poll(() => page.evaluate(() => (window as any).__pendingCapture.getTracks()[0].readyState)).toBe('ended');
});

test('actual LiveKit SDK and matching worker initialize media-only E2EE with native-compatible PBKDF2', async ({ page }) => {
  await setupRoom(page);
  await page.unroute(/\/node_modules\/\.vite\/deps\/livekit-client\.js/);
  await page.goto('/ui/client/');
  const ready = await page.evaluate(async () => {
    const sdkPath = '/ui/node_modules/.vite/deps/livekit-client.js';
    const workerPath = '/ui/node_modules/livekit-client/dist/livekit-client.e2ee.worker.mjs?url';
    const sdk = await import(sdkPath);
    const workerModule = await import(workerPath);
    const worker = new Worker(workerModule.default, { type: 'module' });
    const keyProvider = new sdk.ExternalE2EEKeyProvider();
    const room = new sdk.Room({ e2ee: { keyProvider, worker } });
    try {
      await keyProvider.setKey('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=');
      // The SDK only posts the enable message after an identity is known.
      // Normally room.connect supplies it; this isolated worker test sets it.
      room.localParticipant.identity = 'worker-test';
      const enabled = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('E2EE worker did not acknowledge enable')), 5000);
        room.on(sdk.RoomEvent.ParticipantEncryptionStatusChanged, (value: boolean) => {
          if (value) { clearTimeout(timer); resolve(); }
        });
        worker.addEventListener('error', (error: ErrorEvent) => { clearTimeout(timer); reject(new Error(error.message)); });
      });
      await room.setE2EEEnabled(true);
      await enabled;
      return room.isE2EEEnabled;
    } finally { await room.disconnect(); worker.terminate(); }
  });
  expect(ready).toBe(true);
});

test('room uses media-only E2EE and the padded PBKDF2 passphrase expected by mobile', async ({ page }) => {
  await enterRoom(page);
  const result = await page.evaluate(() => ({
    mediaOnly: Boolean((window as any).__roomOptions.e2ee) && !(window as any).__roomOptions.encryption,
    key: (window as any).__mediaKey,
  }));
  expect(result.mediaOnly).toBe(true);
  expect(result.key).toMatch(/=$/);
});

test('leaving asks for confirmation and cancellation keeps the room open', async ({ page }) => {
  await enterRoom(page);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#leave-room').click();
  await expect(page.locator('#room-view')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#leave-room').click();
  await expect(page.locator('#lobby-view')).toBeVisible();
});

test('saved server token restores the lobby after refresh', async ({ page }) => {
  await setupRoom(page);
  await page.goto('/ui/client/');
  await page.getByLabel('昵称', { exact: true }).fill('林间');
  await page.locator('#access-token-input').fill('saved-token');
  await page.getByRole('button', { name: '连接服务器' }).click();
  await expect(page.locator('#lobby-view')).toBeVisible();
  await page.reload();
  await expect(page.locator('#lobby-view')).toBeVisible();
  await expect(page.locator('#server-name')).toHaveText('曙光之声');
});

test('blocked remote audio remains recoverable without enabling the microphone', async ({ page }) => {
  await enterRoom(page);
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audio = document.createElement('audio');
    audio.srcObject = stream;
    const play = audio.play.bind(audio);
    let blocked = true;
    audio.play = () => {
      if (blocked) { blocked = false; return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError')); }
      return play();
    };
    (window as any).__remoteAudio = audio;
    (window as any).__room.emit('TrackSubscribed', { kind: 'audio', attach: () => audio });
  });
  await expect(page.locator('#resume-audio')).toBeVisible();
  await page.locator('#resume-audio').click();
  await expect(page.locator('#resume-audio')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__remoteAudio.paused)).toBe(false);
  expect(await page.evaluate(() => Boolean((window as any).__track))).toBe(false);
  await page.evaluate(() => { (window as any).__remoteAudio.srcObject.getTracks().forEach((track: MediaStreamTrack) => track.stop()); });
});
