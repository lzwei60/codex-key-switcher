import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptCredentialMigration } from './credential-migration-crypto';
import type { CredentialMigrationPackage } from '@codex-key-switcher/shared';

const payload: CredentialMigrationPackage = {
  format: 'codex-key-switcher-credential-migration', schemaVersion: 1,
  source: 'electron-safe-storage', exportedAt: 1, providers: [],
  credentials: [{ providerId: 'one', apiKey: 'synthetic-secret' }],
};
const passphrase = 'synthetic-passphrase-123';

describe('encrypted credential migration', () => {
  it('encrypts with authentication and fresh randomness', async () => {
    const first = await encryptCredentialMigration(payload, passphrase);
    const second = await encryptCredentialMigration(payload, passphrase);
    expect(JSON.stringify(first)).not.toContain('synthetic-secret');
    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
    const key = pbkdf2Sync(passphrase, Buffer.from(first.salt, 'base64'), first.iterations, 32, 'sha256');
    const bytes = Buffer.from(first.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(first.nonce, 'base64'));
    decipher.setAAD(Buffer.from('codex-key-switcher-encrypted-migration:v2'));
    decipher.setAuthTag(bytes.subarray(-16));
    expect(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString())).toEqual(payload);
  });

  it('rejects weak and oversized passphrases before encryption', async () => {
    await expect(encryptCredentialMigration(payload, 'short')).rejects.toThrow();
    await expect(encryptCredentialMigration(payload, 'x'.repeat(1025))).rejects.toThrow();
  });
});
