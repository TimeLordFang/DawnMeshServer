await import("../internal/server/client/crypto.js");

const { Spake2, deriveInviteScalar, toHex } = globalThis.DawnCrypto;
const scalar = (value) => BigInt(`0x${value}`);
const password = scalar("2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f");
const client = new Spake2({
  isA: true,
  passwordScalar: password,
  testSecret: scalar("43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729"),
});
const host = new Spake2({
  isA: false,
  passwordScalar: password,
  testSecret: scalar("dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be"),
});
if (toHex(client.message) !== "04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c") throw new Error("client SPAKE2 message mismatch");
if (toHex(host.message) !== "0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7") throw new Error("host SPAKE2 message mismatch");

const identityA = new TextEncoder().encode("server");
const identityB = new TextEncoder().encode("client");
const [clientKeys, hostKeys] = await Promise.all([
  client.finish(host.message, identityA, identityB),
  host.finish(client.message, identityA, identityB),
]);
if (toHex(clientKeys.sharedKey) !== "0e0672dc86f8e45565d338b0540abe69") throw new Error("SPAKE2 shared key mismatch");
if (toHex(clientKeys.confirmA) !== "58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0") throw new Error("SPAKE2 client confirmation mismatch");
if (toHex(hostKeys.confirmB) !== "d3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b") throw new Error("SPAKE2 host confirmation mismatch");

const inviteScalar = await deriveInviteScalar("012345");
if (inviteScalar !== BigInt("0x933ac63964a94dea77a765e8e855a4e1829738cb0842f10dc0098a4af0bb4cfdc4fa8ed848c662dd")) {
  throw new Error("scrypt invite derivation mismatch");
}

console.log("DawnMesh browser cryptography vectors passed");
