import { internetInviteCredentials, type Bytes } from './crypto';
const scope = globalThis as unknown as {
 onmessage: ((event: MessageEvent<{code: string; salt: Bytes}>) => void) | null;
 postMessage: (value: unknown) => void;
};
scope.onmessage = async ({data}) => {
 try { scope.postMessage({keys: await internetInviteCredentials(data.code, data.salt)}); }
 catch(error) { scope.postMessage({error: error instanceof Error ? error.message : 'Key derivation failed'}); }
};
