import { createCipheriv, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { CredentialMigrationPackage, EncryptedCredentialMigrationPackage } from '@codex-key-switcher/shared';

const deriveKey = promisify(pbkdf2);
const aad = Buffer.from('codex-key-switcher-encrypted-migration:v2');

export function validateMigrationPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || Array.from(passphrase).length < 16 || Buffer.byteLength(passphrase) > 1024) {
    throw new Error('迁移口令至少需要 16 个字符，且不能超过 1024 字节。');
  }
}

export async function encryptCredentialMigration(
  payload: CredentialMigrationPackage,
  passphrase: string,
): Promise<EncryptedCredentialMigrationPackage> {
  validateMigrationPassphrase(passphrase);
  const plaintext = Buffer.from(JSON.stringify(payload));
  if (plaintext.length > 4 * 1024 * 1024) {
    plaintext.fill(0);
    throw new Error('迁移数据超过大小限制。');
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  let key: Buffer | undefined;
  try {
    key = await deriveKey(passphrase, salt, 600_000, 32, 'sha256');
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return {
      format: 'codex-key-switcher-encrypted-migration', schemaVersion: 2,
      algorithm: 'aes-256-gcm', kdf: 'pbkdf2-sha256', iterations: 600000,
      salt: salt.toString('base64'), nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'),
    };
  } finally {
    plaintext.fill(0);
    key?.fill(0);
  }
}
