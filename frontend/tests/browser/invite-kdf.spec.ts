import { test, expect } from '@playwright/test';
import { setupRoom } from './fixture';

test('KDF worker matches cross-platform vector while UI continues ticking', async ({page}) => {
 await setupRoom(page); await page.goto('/ui/client/');
 const result = await page.evaluate(async () => {
  const modulePath = '/ui/src/client/invite-kdf.ts';
  const {deriveInviteCredentials} = await import(modulePath);
  let ticks = 0;
  const interval = setInterval(() => ticks++, 1);
  try {
   const keys = await deriveInviteCredentials('0012', Uint8Array.from({length:16},(_,i)=>i));
   return {credential: keys.credential, wrappingKey: Array.from(keys.wrappingKey as Uint8Array, v=>v.toString(16).padStart(2,'0')).join(''), ticks};
  } finally { clearInterval(interval); }
 });
 expect(result.credential).toBe('dpGI1xd+eY4DMeu2MRF1VivNsVsVwhXMJQxoyrs0aCw=');
 expect(result.wrappingKey).toBe('ccf348a96242d216f18b5020a342fce88fc22179238a5fa08580109bf764b926');
 expect(result.ticks).toBeGreaterThan(0);
});
test('KDF validation, cancellation and navigation reject without hanging', async ({page}) => {
 await setupRoom(page); await page.goto('/ui/client/');
 const results = await page.evaluate(async () => {
  const modulePath = '/ui/src/client/invite-kdf.ts';
  const {deriveInviteCredentials} = await import(modulePath);
  const errorName = (promise: Promise<unknown>) => promise.then(()=> 'unexpected success', (e: Error)=>e.name);
  const invalid = await errorName(deriveInviteCredentials('invalid',new Uint8Array(16)));
  const controller = new AbortController();
  const aborted = errorName(deriveInviteCredentials('0012',new Uint8Array(16),controller.signal));
  controller.abort();
  const hidden = errorName(deriveInviteCredentials('0012',new Uint8Array(16)));
  window.dispatchEvent(new Event('pagehide'));
  return [invalid,await aborted,await hidden];
 });
 expect(results).toEqual(['Error','AbortError','AbortError']);
});
