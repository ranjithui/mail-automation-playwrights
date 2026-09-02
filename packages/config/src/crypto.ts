/**
 * AES-256-GCM envelope for values that must never be readable at rest or ever
 * reach the frontend: AI API keys and mailbox session secrets.
 *
 * Format: v1.<iv>.<authTag>.<ciphertext>, all base64url.
 */
import crypto from 'node:crypto';
import { env } from './index.js';

const ALGORITHM = 'aes-256-gcm';

function key(): Buffer {
  const raw = env.ENCRYPTION_KEY.trim();
  // A 64-char hex key is used directly; anything else is stretched to 32 bytes
  // so a human-typed value still produces a valid key.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decrypt(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = (payload ?? '').split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

export function tryDecrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

/** Shows only enough of a secret to recognise it: "sk-…9fA2". */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');
