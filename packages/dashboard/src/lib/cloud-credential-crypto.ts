import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const PREFIX = 'somnibot-cloud-v1:';
const INFO = Buffer.from('SomniBot launcher cross-machine credential sync v1', 'utf8');

export function encryptCloudCredential(value: string, baseKey: string, secretKey: string, projectOrigin: string): { key: string; value: string } {
  const key = `${baseKey}_encrypted`;
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(secretKey), Buffer.from(projectOrigin), INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  cipher.setAAD(Buffer.from(key));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { key, value: `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}` };
}

export function decryptCloudCredential(value: string, baseKey: string, secretKey: string, projectOrigin: string): string | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const payload = Buffer.from(value.slice(PREFIX.length), 'base64url');
    if (payload.length < 29) return null;
    const key = `${baseKey}_encrypted`;
    const derived = Buffer.from(hkdfSync('sha256', Buffer.from(secretKey), Buffer.from(projectOrigin), INFO, 32));
    const decipher = createDecipheriv('aes-256-gcm', derived, payload.subarray(0, 12));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
