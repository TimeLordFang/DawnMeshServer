import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaKey } from '../src/shared/media-key.ts';
import { MicrophoneGate } from '../src/shared/microphone-gate.ts';
import { base64Url } from '../src/client/crypto.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('browser media passphrase matches Dart base64UrlEncode and native PBKDF2 defaults', async () => {
  const raw = Uint8Array.from({ length: 32 }, (_, index) => index);
  const expected = Buffer.from(raw).toString('base64url') + '=';
  const key = mediaKey(base64Url(raw));
  assert.equal(key, expected);
  assert.equal(key, mediaKey(expected));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), 'PBKDF2', false, ['deriveBits']);
  const params = { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('LKFrameEncryptionKey'), iterations: 100000 } as const;
  const browser = await crypto.subtle.deriveBits(params, material, 128);
  const nativeDefault = await crypto.subtle.deriveBits(params,
    await crypto.subtle.importKey('raw', new TextEncoder().encode(expected), 'PBKDF2', false, ['deriveBits']), 128);
  assert.deepEqual(new Uint8Array(browser), new Uint8Array(nativeDefault));
});

test('release during pending unmute immediately closes capture and remains muted after completion', async () => {
  const pending = deferred();
  let muted = true;
  const track = {
    mediaStreamTrack: { enabled: true, stop() {} },
    async mute() { muted = true; this.mediaStreamTrack.enabled = false; },
    async unmute() { await pending.promise; muted = false; this.mediaStreamTrack.enabled = true; },
    stop() { this.mediaStreamTrack.enabled = false; },
  };
  const gate = new MicrophoneGate();
  gate.attach(track);
  assert.equal(track.mediaStreamTrack.enabled, false);
  const down = gate.set(true);
  await new Promise(resolve => setImmediate(resolve));
  const up = gate.set(false);
  assert.equal(track.mediaStreamTrack.enabled, false);
  pending.resolve();
  await Promise.all([down, up]);
  assert.equal(track.mediaStreamTrack.enabled, false);
  assert.equal(muted, true);
});

test('release before capture arrives never unmutes it; disposing stops late tracks', async () => {
  let unmuted = 0, stopped = 0;
  const track = {
    mediaStreamTrack: { enabled: true, stop() {} },
    async mute() { this.mediaStreamTrack.enabled = false; },
    async unmute() { unmuted++; this.mediaStreamTrack.enabled = true; },
    stop() { stopped++; this.mediaStreamTrack.enabled = false; },
  };
  const gate = new MicrophoneGate();
  await gate.set(true);
  await gate.set(false);
  gate.attach(track);
  await gate.set(false);
  assert.equal(unmuted, 0);
  assert.equal(track.mediaStreamTrack.enabled, false);
  gate.dispose();
  gate.attach(track);
  await gate.set(true);
  assert.equal(unmuted, 0);
  assert.equal(stopped, 2);
});

test('dispose during SDK unmute also stops a late reacquired track', async () => {
  const pending = deferred();
  let stopped = 0;
  const track = {
    mediaStreamTrack: { enabled: false, stop() {} },
    async mute() { this.mediaStreamTrack.enabled = false; },
    async unmute() { await pending.promise; this.mediaStreamTrack.enabled = true; },
    stop() { stopped++; this.mediaStreamTrack.enabled = false; },
  };
  const gate = new MicrophoneGate();
  gate.attach(track);
  const starting = gate.set(true);
  await new Promise(resolve => setImmediate(resolve));
  gate.dispose();
  pending.resolve();
  await starting;
  assert.equal(track.mediaStreamTrack.enabled, false);
  assert.equal(stopped, 2);
});
