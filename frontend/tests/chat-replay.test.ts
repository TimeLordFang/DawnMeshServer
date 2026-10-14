import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatCipher } from '../src/client/crypto.ts';
test('prefix exhaustion rejects only newcomers and retains replay protection', async () => {
 const key = new Uint8Array(32).fill(9), aad = new Uint8Array([1]);
 const receiver = await ChatCipher.create(key);
 const first = await ChatCipher.create(key);
 const old = await first.encrypt(new Uint8Array([1]), aad);
 await receiver.decrypt(old, aad);
 for (let i=1;i<128;i++) {
  const sender = await ChatCipher.create(key);
  await receiver.decrypt(await sender.encrypt(new Uint8Array([1]),aad),aad);
 }
 const newcomer = await ChatCipher.create(key);
 for(let i=0;i<3;i++) await assert.rejects(receiver.decrypt(await newcomer.encrypt(new Uint8Array([1]),aad),aad),/too many chat senders/);
 assert.equal(receiver.seen.size,128);
 assert.deepEqual(await receiver.decrypt(await first.encrypt(new Uint8Array([2]),aad),aad),new Uint8Array([2]));
 await assert.rejects(receiver.decrypt(old,aad),/replayed/);
});
