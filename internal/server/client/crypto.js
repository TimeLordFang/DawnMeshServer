"use strict";

(function (global) {
  const webCrypto = global.crypto;
  if (!webCrypto?.subtle) throw new Error("Web Crypto is unavailable");
  const subtle = webCrypto.subtle;
  const utf8 = new TextEncoder();
  const P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
  const A = P - 3n;
  const B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
  const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  const G = {
    x: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
    y: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
  };

  function mod(value, modulus = P) {
    const result = value % modulus;
    return result >= 0n ? result : result + modulus;
  }

  function modPow(base, exponent, modulus = P) {
    let result = 1n;
    let value = mod(base, modulus);
    for (let power = exponent; power > 0n; power >>= 1n) {
      if (power & 1n) result = (result * value) % modulus;
      value = (value * value) % modulus;
    }
    return result;
  }

  function modInverse(value) {
    let low = mod(value);
    let high = P;
    let lm = 1n;
    let hm = 0n;
    while (low > 1n) {
      const ratio = high / low;
      [lm, hm] = [hm - lm * ratio, lm];
      [low, high] = [high - low * ratio, low];
    }
    if (low !== 1n) throw new Error("invalid curve denominator");
    return mod(lm);
  }

  function pointAdd(left, right) {
    if (!left) return right;
    if (!right) return left;
    if (left.x === right.x && mod(left.y + right.y) === 0n) return null;
    let slope;
    if (left.x === right.x && left.y === right.y) {
      if (left.y === 0n) return null;
      slope = mod((3n * left.x * left.x + A) * modInverse(2n * left.y));
    } else {
      slope = mod((right.y - left.y) * modInverse(right.x - left.x));
    }
    const x = mod(slope * slope - left.x - right.x);
    const y = mod(slope * (left.x - x) - left.y);
    return { x, y };
  }

  function pointMultiply(scalar, point) {
    let amount = mod(scalar, N);
    let result = null;
    let addend = point;
    while (amount > 0n) {
      if (amount & 1n) result = pointAdd(result, addend);
      addend = pointAdd(addend, addend);
      amount >>= 1n;
    }
    return result;
  }

  function pointNegate(point) {
    return point ? { x: point.x, y: mod(-point.y) } : null;
  }

  function bigintFromBytes(bytes) {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
  }

  function bigintBytes(value, length = 32) {
    const output = new Uint8Array(length);
    let remaining = value;
    for (let index = length - 1; index >= 0; index -= 1) {
      output[index] = Number(remaining & 255n);
      remaining >>= 8n;
    }
    if (remaining !== 0n) throw new Error("integer does not fit");
    return output;
  }

  function decodeCompressed(hex) {
    const bytes = hexBytes(hex);
    const x = bigintFromBytes(bytes.slice(1));
    const ySquared = mod(x * x * x + A * x + B);
    let y = modPow(ySquared, (P + 1n) >> 2n);
    const odd = Number(y & 1n);
    if (odd !== (bytes[0] & 1)) y = P - y;
    return { x, y };
  }

  function decodePoint(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 65 || bytes[0] !== 4) {
      throw new Error("invalid SEC1 point");
    }
    const point = {
      x: bigintFromBytes(bytes.slice(1, 33)),
      y: bigintFromBytes(bytes.slice(33)),
    };
    if (point.x >= P || point.y >= P || mod(point.y * point.y - point.x * point.x * point.x - A * point.x - B) !== 0n) {
      throw new Error("point is not on P-256");
    }
    return point;
  }

  function encodePoint(point) {
    if (!point) throw new Error("point at infinity");
    return concat(new Uint8Array([4]), bigintBytes(point.x), bigintBytes(point.y));
  }

  const M = decodeCompressed("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f");
  const MASK_N = decodeCompressed("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49");

  function concat(...arrays) {
    const length = arrays.reduce((sum, value) => sum + value.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const value of arrays) {
      output.set(value, offset);
      offset += value.length;
    }
    return output;
  }

  function hexBytes(value) {
    const output = new Uint8Array(value.length / 2);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return output;
  }

  function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function randomScalar() {
    while (true) {
      const bytes = webCrypto.getRandomValues(new Uint8Array(32));
      const value = bigintFromBytes(bytes);
      if (value > 0n && value < N) return value;
    }
  }

  function uint64LE(value) {
    const output = new Uint8Array(8);
    let remaining = BigInt(value);
    for (let index = 0; index < 8; index += 1) {
      output[index] = Number(remaining & 255n);
      remaining >>= 8n;
    }
    return output;
  }

  async function sha256(value) {
    return new Uint8Array(await subtle.digest("SHA-256", value));
  }

  async function hmac(key, value) {
    const cryptoKey = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await subtle.sign("HMAC", cryptoKey, value));
  }

  async function dawnHkdf(key, info) {
    const prk = await hmac(new Uint8Array(32), key);
    return hmac(prk, concat(utf8.encode(info), new Uint8Array([1])));
  }

  class Spake2 {
    constructor({ isA, passwordScalar, testSecret = null }) {
      this.isA = isA;
      this.passwordScalar = mod(passwordScalar, N);
      this.secret = testSecret ?? randomScalar();
      this.used = false;
      const mask = isA ? M : MASK_N;
      this.point = pointAdd(pointMultiply(this.secret, G), pointMultiply(this.passwordScalar, mask));
      this.message = encodePoint(this.point);
    }

    async finish(peerBytes, identityA, identityB) {
      if (this.used) throw new Error("PAKE ephemeral must not be reused");
      this.used = true;
      const peer = decodePoint(peerBytes);
      const peerMask = this.isA ? MASK_N : M;
      const unmasked = pointAdd(peer, pointNegate(pointMultiply(this.passwordScalar, peerMask)));
      const shared = pointMultiply(this.secret, unmasked);
      if (!shared) throw new Error("invalid PAKE secret");
      const fields = [
        identityA,
        identityB,
        this.isA ? this.message : peerBytes,
        this.isA ? peerBytes : this.message,
        encodePoint(shared),
        bigintBytes(this.passwordScalar),
      ];
      const transcript = concat(...fields.flatMap((field) => [uint64LE(field.length), field]));
      const digest = await sha256(transcript);
      const confirmationKeys = await dawnHkdf(digest.slice(16), "ConfirmationKeys");
      return {
        transcript,
        sharedKey: digest.slice(0, 16),
        confirmA: await hmac(confirmationKeys.slice(0, 16), transcript),
        confirmB: await hmac(confirmationKeys.slice(16), transcript),
      };
    }
  }

  function rotateLeft(value, count) {
    return ((value << count) | (value >>> (32 - count))) >>> 0;
  }

  function salsa208(block) {
    const x = new Uint32Array(block);
    for (let round = 0; round < 8; round += 2) {
      x[4] ^= rotateLeft((x[0] + x[12]) >>> 0, 7);
      x[8] ^= rotateLeft((x[4] + x[0]) >>> 0, 9);
      x[12] ^= rotateLeft((x[8] + x[4]) >>> 0, 13);
      x[0] ^= rotateLeft((x[12] + x[8]) >>> 0, 18);
      x[9] ^= rotateLeft((x[5] + x[1]) >>> 0, 7);
      x[13] ^= rotateLeft((x[9] + x[5]) >>> 0, 9);
      x[1] ^= rotateLeft((x[13] + x[9]) >>> 0, 13);
      x[5] ^= rotateLeft((x[1] + x[13]) >>> 0, 18);
      x[14] ^= rotateLeft((x[10] + x[6]) >>> 0, 7);
      x[2] ^= rotateLeft((x[14] + x[10]) >>> 0, 9);
      x[6] ^= rotateLeft((x[2] + x[14]) >>> 0, 13);
      x[10] ^= rotateLeft((x[6] + x[2]) >>> 0, 18);
      x[3] ^= rotateLeft((x[15] + x[11]) >>> 0, 7);
      x[7] ^= rotateLeft((x[3] + x[15]) >>> 0, 9);
      x[11] ^= rotateLeft((x[7] + x[3]) >>> 0, 13);
      x[15] ^= rotateLeft((x[11] + x[7]) >>> 0, 18);
      x[1] ^= rotateLeft((x[0] + x[3]) >>> 0, 7);
      x[2] ^= rotateLeft((x[1] + x[0]) >>> 0, 9);
      x[3] ^= rotateLeft((x[2] + x[1]) >>> 0, 13);
      x[0] ^= rotateLeft((x[3] + x[2]) >>> 0, 18);
      x[6] ^= rotateLeft((x[5] + x[4]) >>> 0, 7);
      x[7] ^= rotateLeft((x[6] + x[5]) >>> 0, 9);
      x[4] ^= rotateLeft((x[7] + x[6]) >>> 0, 13);
      x[5] ^= rotateLeft((x[4] + x[7]) >>> 0, 18);
      x[11] ^= rotateLeft((x[10] + x[9]) >>> 0, 7);
      x[8] ^= rotateLeft((x[11] + x[10]) >>> 0, 9);
      x[9] ^= rotateLeft((x[8] + x[11]) >>> 0, 13);
      x[10] ^= rotateLeft((x[9] + x[8]) >>> 0, 18);
      x[12] ^= rotateLeft((x[15] + x[14]) >>> 0, 7);
      x[13] ^= rotateLeft((x[12] + x[15]) >>> 0, 9);
      x[14] ^= rotateLeft((x[13] + x[12]) >>> 0, 13);
      x[15] ^= rotateLeft((x[14] + x[13]) >>> 0, 18);
    }
    for (let index = 0; index < 16; index += 1) block[index] = (block[index] + x[index]) >>> 0;
  }

  function blockMix(input, r) {
    const x = new Uint32Array(input.slice((2 * r - 1) * 16, 2 * r * 16));
    const y = new Uint32Array(input.length);
    for (let block = 0; block < 2 * r; block += 1) {
      const offset = block * 16;
      for (let word = 0; word < 16; word += 1) x[word] ^= input[offset + word];
      salsa208(x);
      y.set(x, offset);
    }
    const output = new Uint32Array(input.length);
    for (let block = 0; block < r; block += 1) output.set(y.slice(block * 32, block * 32 + 16), block * 16);
    for (let block = 0; block < r; block += 1) output.set(y.slice(block * 32 + 16, block * 32 + 32), (block + r) * 16);
    return output;
  }

  function bytesToLittleWords(bytes) {
    const words = new Uint32Array(bytes.length / 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < words.length; index += 1) words[index] = view.getUint32(index * 4, true);
    return words;
  }

  function littleWordsToBytes(words) {
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < words.length; index += 1) view.setUint32(index * 4, words[index], true);
    return bytes;
  }

  async function pbkdf2(password, salt, length) {
    const key = await subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1 }, key, length * 8));
  }

  async function scrypt(password, salt, n = 16384, r = 8, p = 1, length = 40) {
    if ((n & (n - 1)) !== 0 || n <= 1 || p !== 1) throw new Error("unsupported scrypt parameters");
    const initial = await pbkdf2(password, salt, p * 128 * r);
    let x = bytesToLittleWords(initial);
    const blockWords = 32 * r;
    const memory = new Uint32Array(n * blockWords);
    for (let index = 0; index < n; index += 1) {
      memory.set(x, index * blockWords);
      x = blockMix(x, r);
    }
    for (let index = 0; index < n; index += 1) {
      const selected = x[(2 * r - 1) * 16] & (n - 1);
      const offset = selected * blockWords;
      for (let word = 0; word < blockWords; word += 1) x[word] ^= memory[offset + word];
      x = blockMix(x, r);
    }
    memory.fill(0);
    return pbkdf2(password, littleWordsToBytes(x), length);
  }

  async function deriveInviteScalar(code) {
    if (!/^\d{6}$/.test(code)) throw new Error("请输入 6 位数字邀请码");
    const bytes = await scrypt(utf8.encode(code), utf8.encode("DawnMesh SPAKE2 PIN v2"));
    return bigintFromBytes(bytes);
  }

  function timingSafeEqual(left, right) {
    if (left.length !== right.length) return false;
    let different = 0;
    for (let index = 0; index < left.length; index += 1) different |= left[index] ^ right[index];
    return different === 0;
  }

  async function aesEncrypt(keyBytes, plaintext, aad, nonce = webCrypto.getRandomValues(new Uint8Array(12))) {
    const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
    const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext));
    return concat(nonce, ciphertext);
  }

  async function aesDecrypt(keyBytes, packet, aad) {
    if (packet.length < 29) throw new Error("encrypted packet is too short");
    const key = await subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: packet.slice(0, 12), additionalData: aad, tagLength: 128 }, key, packet.slice(12)));
  }

  class ChatCipher {
    constructor(key) {
      this.key = key;
      this.prefix = webCrypto.getRandomValues(new Uint8Array(8));
      this.counter = 0;
      this.seen = new Map();
    }

    static async create(roomKey) {
      return new ChatCipher(await dawnHkdf(roomKey, "DawnMesh internet chat v1"));
    }

    async encrypt(plaintext, aad) {
      if (this.counter > 0xffffffff) throw new Error("chat key exhausted");
      const nonce = new Uint8Array(12);
      nonce.set(this.prefix);
      new DataView(nonce.buffer).setUint32(8, this.counter++, false);
      return aesEncrypt(this.key, plaintext, aad, nonce);
    }

    async decrypt(packet, aad) {
      const clear = await aesDecrypt(this.key, packet, aad);
      const prefix = base64(packet.slice(0, 8));
      const counter = new DataView(packet.buffer, packet.byteOffset + 8, 4).getUint32(0, false);
      const previous = this.seen.get(prefix) ?? -1;
      if (counter <= previous) throw new Error("replayed chat packet");
      this.seen.set(prefix, counter);
      if (this.seen.size > 128) throw new Error("too many chat senders");
      return clear;
    }
  }

  function base64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64Url(bytes) {
    return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  function fromBase64(value) {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  global.DawnCrypto = {
    ChatCipher,
    Spake2,
    aesDecrypt,
    aesEncrypt,
    base64,
    base64Url,
    concat,
    dawnHkdf,
    deriveInviteScalar,
    fromBase64,
    hexBytes,
    timingSafeEqual,
    toHex,
    utf8,
  };
})(globalThis);
