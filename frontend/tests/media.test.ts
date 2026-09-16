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

test('browser media key matches Dart base64UrlEncode, including padding and HKDF input', async () => {
  const raw = Uint8Array.from({ length: 32 }, (_, index) => index);
  const expected = Buffer.from(raw).toString('base64url') + '=';
  const key = mediaKey(base64Url(raw));
  assert.equal(new TextDecoder().decode(key), expected);
  assert.deepEqual(key, mediaKey(expected));
  const importKey = (bytes: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('LKFrameEncryptionKey'), info: new TextEncoder().encode('test') };
  const native = await crypto.subtle.deriveBits(params, await importKey(new TextEncoder().encode(expected)), 256);
  const browser = await crypto.subtle.deriveBits(params, await importKey(key), 256);
  assert.deepEqual(new Uint8Array(browser), new Uint8Array(native));
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
