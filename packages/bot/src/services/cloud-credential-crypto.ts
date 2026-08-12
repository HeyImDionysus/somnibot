import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const PREFIX = 'somnibot-cloud-v1:';
const INFO = Buffer.from('SomniBot launcher cross-machine credential sync v1', 'utf8');

function keyFor(secretKey: string, projectOrigin: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretKey), Buffer.from(projectOrigin), INFO, 32));
}

export function encryptedCredentialSettingKey(baseKey: string): string {
  return `${baseKey}_encrypted`;
}

export function encryptCloudCredential(value: string, baseKey: string, secretKey: string, projectOrigin: string): string {
  const settingsKey = encryptedCredentialSettingKey(baseKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secretKey, projectOrigin), iv);
  cipher.setAAD(Buffer.from(settingsKey));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

export function decryptCloudCredential(value: string, baseKey: string, secretKey: string, projectOrigin: string): string | null {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const payload = Buffer.from(value.slice(PREFIX.length), 'base64url');
    if (payload.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secretKey, projectOrigin), payload.subarray(0, 12));
    decipher.setAAD(Buffer.from(encryptedCredentialSettingKey(baseKey)));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
