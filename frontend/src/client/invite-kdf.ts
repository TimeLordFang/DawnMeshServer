import type { Bytes, internetInviteCredentials } from './crypto';
type Keys = Awaited<ReturnType<typeof internetInviteCredentials>>;
export function deriveInviteCredentials(code: string, salt: Bytes, signal?: AbortSignal): Promise<Keys> {
 return new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
  const worker = new Worker(new URL('./invite-worker.ts', import.meta.url), {type: 'module'});
  const finish = (error?: Error, keys?: Keys) => {
   clearTimeout(timer);
   signal?.removeEventListener('abort', cancel);
   window.removeEventListener('pagehide', cancel);
   worker.terminate();
   if(error) reject(error); else resolve(keys!);
  };
  const cancel = () => finish(new DOMException('Cancelled', 'AbortError'));
  const timer = setTimeout(() => finish(new Error('Key derivation timed out')), 30000);
  signal?.addEventListener('abort', cancel, {once: true});
  window.addEventListener('pagehide', cancel, {once: true});
  worker.onmessage = ({data}: MessageEvent<{keys?: Keys; error?: string}>) => {
   if(data.error || !data.keys) finish(new Error(data.error || 'Invalid key derivation result'));
   else finish(undefined, data.keys);
  };
  worker.onerror = () => finish(new Error('Key derivation worker failed'));
  worker.onmessageerror = () => finish(new Error('Key derivation response could not be decoded'));
  try { worker.postMessage({code, salt}); } catch(error) { finish(error instanceof Error ? error : new Error(String(error))); }
 });
}
