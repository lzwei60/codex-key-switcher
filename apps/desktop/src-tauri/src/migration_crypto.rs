use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;

use crate::{commands::CommandError, providers::CredentialMigrationPackage};

const AAD: &[u8] = b"codex-key-switcher-encrypted-migration:v2";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncryptedMigrationPackage {
    pub format: String,
    pub schema_version: u8,
    pub algorithm: String,
    pub kdf: String,
    pub iterations: u32,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

pub fn encrypt(
    payload: &CredentialMigrationPackage,
    passphrase: &str,
) -> Result<EncryptedMigrationPackage, CommandError> {
    if passphrase.chars().count() < 16 || passphrase.len() > 1024 {
        return Err(CommandError::new(
            "MIGRATION_INVALID_PASSPHRASE",
            "迁移口令至少需要 16 个字符，且不能超过 1024 字节。",
        ));
    }
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    let rng = SystemRandom::new();
    rng.fill(&mut salt).map_err(|_| invalid())?;
    rng.fill(&mut nonce).map_err(|_| invalid())?;
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600_000).unwrap(),
        &salt,
        passphrase.as_bytes(),
        &mut key,
    );
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| invalid())?;
    key.fill(0);
    let mut ciphertext = serde_json::to_vec(payload).map_err(|_| invalid())?;
    if ciphertext.len() > 4 * 1024 * 1024 {
        return Err(CommandError::new(
            "MIGRATION_TOO_LARGE",
            "迁移数据超过大小限制。",
        ));
    }
    aead::LessSafeKey::new(unbound)
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(AAD),
            &mut ciphertext,
        )
        .map_err(|_| invalid())?;
    Ok(EncryptedMigrationPackage {
        format: "codex-key-switcher-encrypted-migration".into(),
        schema_version: 2,
        algorithm: "aes-256-gcm".into(),
        kdf: "pbkdf2-sha256".into(),
        iterations: 600_000,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}

pub fn decrypt(
    input: EncryptedMigrationPackage,
    passphrase: &str,
) -> Result<CredentialMigrationPackage, CommandError> {
    if input.format != "codex-key-switcher-encrypted-migration"
        || input.schema_version != 2
        || input.algorithm != "aes-256-gcm"
        || input.kdf != "pbkdf2-sha256"
        || input.iterations != 600_000
        || passphrase.chars().count() < 16
        || passphrase.len() > 1024
        || input.ciphertext.len() > 5_600_000
        || input.salt.len() > 24
        || input.nonce.len() > 16
    {
        return Err(invalid());
    }
    let salt = STANDARD.decode(input.salt).map_err(|_| invalid())?;
    let nonce: [u8; 12] = STANDARD
        .decode(input.nonce)
        .map_err(|_| invalid())?
        .try_into()
        .map_err(|_| invalid())?;
    if salt.len() != 16 {
        return Err(invalid());
    }
    let mut ciphertext = STANDARD.decode(input.ciphertext).map_err(|_| invalid())?;
    if ciphertext.len() > 4 * 1024 * 1024 + 16 {
        return Err(invalid());
    }
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600_000).unwrap(),
        &salt,
        passphrase.as_bytes(),
        &mut key,
    );
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| invalid());
    key.fill(0);
    let result = (|| {
        let key = aead::LessSafeKey::new(unbound?);
        let plaintext = key
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(AAD),
                &mut ciphertext,
            )
            .map_err(|_| invalid())?;
        serde_json::from_slice(plaintext).map_err(|_| invalid())
    })();
    ciphertext.fill(0);
    result
}

fn invalid() -> CommandError {
    CommandError::new(
        "MIGRATION_DECRYPT_FAILED",
        "迁移口令错误或加密包无效；旧明文包不再支持。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypts_node_crypto_package_and_rejects_wrong_password_tampering_and_plaintext() {
        // Match the Electron Node crypto wire format, including the trailing GCM tag.
        let output = std::process::Command::new("node").args(["-e", r#"
          const c = require('node:crypto');
          const salt = c.randomBytes(16), nonce = c.randomBytes(12);
          const key = c.pbkdf2Sync('synthetic-passphrase-123', salt, 600000, 32, 'sha256');
          const cipher = c.createCipheriv('aes-256-gcm', key, nonce);
          cipher.setAAD(Buffer.from('codex-key-switcher-encrypted-migration:v2'));
          const payload = {format:'codex-key-switcher-credential-migration', schemaVersion:1,
            source:'electron-safe-storage',exportedAt:1,providers:[],credentials:[]};
          const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final(),cipher.getAuthTag()]);
          console.log(JSON.stringify({format:'codex-key-switcher-encrypted-migration',schemaVersion:2,
            algorithm:'aes-256-gcm',kdf:'pbkdf2-sha256',iterations:600000,
            salt:salt.toString('base64'),nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64')}));
        "#]).output().expect("Node is required for the cross-runtime contract test");
        assert!(output.status.success());
        let mut value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(decrypt(
            serde_json::from_value(value.clone()).unwrap(),
            "synthetic-passphrase-123"
        )
        .is_ok());
        assert!(decrypt(
            serde_json::from_value(value.clone()).unwrap(),
            "incorrect-passphrase"
        )
        .is_err());
        let mut bytes = STANDARD
            .decode(value["ciphertext"].as_str().unwrap())
            .unwrap();
        bytes[0] ^= 1;
        value["ciphertext"] = serde_json::json!(STANDARD.encode(bytes));
        assert!(decrypt(
            serde_json::from_value(value).unwrap(),
            "synthetic-passphrase-123"
        )
        .is_err());
        assert!(serde_json::from_str::<EncryptedMigrationPackage>(
            r#"{"schemaVersion":1,"credentials":[]}"#
        )
        .is_err());
    }
}
