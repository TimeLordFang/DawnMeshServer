/** Dart's base64UrlEncode retains padding. These exact UTF-8 bytes are the
 * native LiveKit HKDF input; passing a JS string would select PBKDF2 instead. */
export function mediaKey(encoded: string): Uint8Array<ArrayBuffer> {
  const normalized = encoded.replaceAll('+', '-').replaceAll('/', '_');
  return new TextEncoder().encode(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
}
