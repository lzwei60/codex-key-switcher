use crate::commands::CommandError;

const SERVICE: &str = "com.codexkeyswitcher.tauri.preview.credentials";

pub trait SecretBackend: Send + Sync {
    fn set(&self, provider_id: &str, value: &str) -> Result<(), CommandError>;
    fn get(&self, provider_id: &str) -> Result<Option<String>, CommandError>;
    fn delete(&self, provider_id: &str) -> Result<(), CommandError>;
}

pub struct SystemKeyring;

impl SystemKeyring {
    fn entry(provider_id: &str) -> Result<keyring::Entry, CommandError> {
        if provider_id.trim().is_empty() || provider_id.len() > 256 || provider_id.contains('\0') {
            return Err(CommandError::new("INVALID_PROVIDER_ID", "供应商标识无效。"));
        }
        keyring::Entry::new(SERVICE, provider_id)
            .map_err(|_| CommandError::new("KEYRING_UNAVAILABLE", "系统凭据存储不可用。"))
    }
}

impl SecretBackend for SystemKeyring {
    fn set(&self, provider_id: &str, value: &str) -> Result<(), CommandError> {
        if value.trim().is_empty() {
            return Err(CommandError::new("EMPTY_CREDENTIAL", "API Key 不能为空。"));
        }
        Self::entry(provider_id)?
            .set_password(value)
            .map_err(|_| CommandError::new("KEYRING_WRITE_FAILED", "无法安全保存 API Key。"))
    }

    fn get(&self, provider_id: &str) -> Result<Option<String>, CommandError> {
        match Self::entry(provider_id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CommandError::new(
                "KEYRING_READ_FAILED",
                "无法读取系统凭据。",
            )),
        }
    }

    fn delete(&self, provider_id: &str) -> Result<(), CommandError> {
        match Self::entry(provider_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CommandError::new(
                "KEYRING_DELETE_FAILED",
                "无法删除系统凭据。",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct MemoryKeyring(Mutex<HashMap<String, String>>);

    impl SecretBackend for MemoryKeyring {
        fn set(&self, provider_id: &str, value: &str) -> Result<(), CommandError> {
            self.0
                .lock()
                .unwrap()
                .insert(provider_id.into(), value.into());
            Ok(())
        }

        fn get(&self, provider_id: &str) -> Result<Option<String>, CommandError> {
            Ok(self.0.lock().unwrap().get(provider_id).cloned())
        }

        fn delete(&self, provider_id: &str) -> Result<(), CommandError> {
            self.0.lock().unwrap().remove(provider_id);
            Ok(())
        }
    }

    #[test]
    fn credential_backend_contract_is_isolated_and_reversible() {
        let backend = MemoryKeyring::default();
        assert!(backend.get("provider").unwrap().is_none());
        backend.set("provider", "synthetic-test-key").unwrap();
        assert_eq!(
            backend.get("provider").unwrap().as_deref(),
            Some("synthetic-test-key")
        );
        backend.delete("provider").unwrap();
        assert!(backend.get("provider").unwrap().is_none());
    }

    #[test]
    fn invalid_ids_are_rejected_before_touching_the_os_keyring() {
        assert!(SystemKeyring::entry("").is_err());
        assert!(SystemKeyring::entry("bad\0id").is_err());
    }
}
