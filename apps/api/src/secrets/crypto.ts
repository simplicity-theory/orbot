import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyId: string;
}

/** Short fingerprint of the key so a rotated master key can be detected. Not reversible. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** AES-256-GCM with the secret's name as additional authenticated data. */
export function seal(key: Buffer, name: string, value: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyId: keyId(key) };
}

export function open(key: Buffer, name: string, s: Omit<Sealed, 'keyId'>): string {
  const decipher = createDecipheriv('aes-256-gcm', key, s.iv);
  decipher.setAAD(Buffer.from(name, 'utf8'));
  decipher.setAuthTag(s.authTag);
  return Buffer.concat([decipher.update(s.ciphertext), decipher.final()]).toString('utf8');
}
