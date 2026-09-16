/** Dart's base64UrlEncode retains padding. Native LiveKit's default key
 * provider treats this value as a PBKDF2 passphrase, so the browser must pass
 * the same normalized string to ExternalE2EEKeyProvider. */
export function mediaKey(encoded: string): string {
  const normalized = encoded.replaceAll('+', '-').replaceAll('/', '_');
  return normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
}
