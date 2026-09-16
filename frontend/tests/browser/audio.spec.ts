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
  await page.locator('#leave-room').click();
  await expect.poll(() => page.evaluate(() => (window as any).__track.mediaStreamTrack.readyState)).toBe('ended');
});

test('denied microphone still allows listening and has a retry path', async ({ page }) => {
  await enterRoom(page);
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
  await page.locator('#enable-audio-devices').click();
  await expect(page.locator('#audio-device-status')).toContainText('麦克风权限');
  await expect(page.locator('#enable-audio-devices')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__room.canPlaybackAudio)).toBe(true);
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
  await page.locator('#leave-room').click();
  await expect.poll(() => page.evaluate(() => (window as any).__pendingCapture.getTracks()[0].readyState)).toBe('ended');
});

test('actual LiveKit SDK and matching worker initialize E2EE with native-compatible bytes', async ({ page }) => {
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
    const room = new sdk.Room({ encryption: { keyProvider, worker } });
    try {
      await keyProvider.setKey(new TextEncoder().encode('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=').buffer);
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
