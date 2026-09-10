import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env';

/**
 * AES-256-GCM envelope encryption for integration credentials.
 *
 * Format: v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
 * The key comes from ENCRYPTION_KEY (base64 or raw); anything shorter than 32 bytes is
 * stretched with SHA-256 so a human-typed value still yields a valid key.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.encryptionKey;
  let buf: Buffer;
  try {
    const decoded = Buffer.from(raw, 'base64');
    buf = decoded.length === 32 ? decoded : Buffer.from(raw, 'utf8');
  } catch {
    buf = Buffer.from(raw, 'utf8');
  }
  cachedKey = buf.length === 32 ? buf : createHash('sha256').update(buf).digest();
  return cachedKey;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted payload');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64!, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T = unknown>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T;
}

/** Try to decrypt; return null instead of throwing when the key rotated or data is corrupt. */
export function tryDecryptJson<T = unknown>(payload: string | null | undefined): T | null {
  if (!payload) return null;
  try {
    return decryptJson<T>(payload);
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Stable fingerprint used to dedupe issues, notifications and suggestions. */
export function fingerprint(...parts: Array<string | number | null | undefined>): string {
  return createHash('sha1').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex');
}
