use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    sync::Mutex,
};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::commands::CommandError;

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

pub struct PreviewStore {
    directory: PathBuf,
    write_lock: Mutex<()>,
    provider_transaction_lock: Mutex<()>,
}

impl PreviewStore {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            write_lock: Mutex::new(()),
            provider_transaction_lock: Mutex::new(()),
        }
    }

    pub fn usage_database_path(&self) -> PathBuf {
        self.directory.join("usage.sqlite")
    }

    pub(crate) fn preview_data_directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn ensure_preview_directory(&self) -> Result<(), CommandError> {
        ensure_private_directory(&self.directory)
    }

    pub fn local_gateway_api_key(&self) -> Result<String, CommandError> {
        let settings = self.read_settings()?;
        if let Some(value) = settings
            .get("localGatewayAPIKey")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            return Ok(value.to_string());
        }
        let value = format!("cksw-{}", Uuid::new_v4());
        self.update_settings([("localGatewayAPIKey".into(), json!(value.clone()))])?;
        Ok(value)
    }

    pub(crate) fn configured_codex_directory_for_catalog(&self) -> PathBuf {
        self.directory.join("codex-sandbox")
    }

    pub(crate) fn provider_transaction<T>(
        &self,
        operation: impl FnOnce() -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let _guard = self.provider_transaction_lock.lock().map_err(io_error)?;
        operation()
    }

    pub fn read_settings(&self) -> Result<Map<String, Value>, CommandError> {
        let value = read_json(&self.directory.join("settings.json"))?;
        match value {
            None => Ok(Map::new()),
            Some(Value::Object(values)) => Ok(values),
            _ => Err(CommandError::new(
                "INVALID_SETTINGS",
                "预览设置文件格式无效。",
            )),
        }
    }

    pub fn update_settings(
        &self,
        updates: impl IntoIterator<Item = (String, Value)>,
    ) -> Result<(), CommandError> {
        let _guard = self.write_lock.lock().map_err(io_error)?;
        let mut settings = self.read_settings()?;
        settings.extend(updates);
        self.write_settings(&settings)
    }

    fn write_settings(&self, settings: &Map<String, Value>) -> Result<(), CommandError> {
        ensure_private_directory(&self.directory)?;
        let destination = self.directory.join("settings.json");
        check_regular_file(&destination)?;
        let temporary = self.directory.join(format!(
            ".settings.{}.{}.tmp",
            std::process::id(),
            TEMP_ID.fetch_add(1, Ordering::Relaxed),
        ));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(io_error)?;
            serde_json::to_writer_pretty(&mut file, settings).map_err(|_| io_error(()))?;
            file.write_all(b"\n").map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            replace_file(&temporary, &destination).map_err(io_error)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn list_providers(&self) -> Result<Value, CommandError> {
        let Some(payload) = read_json(&self.directory.join("providers.json"))? else {
            return Ok(json!([]));
        };
        let Value::Object(root) = payload else {
            return Err(CommandError::new(
                "INVALID_PROVIDERS",
                "预览供应商文件格式无效。",
            ));
        };
        let Some(Value::Array(providers)) = root.get("providers") else {
            return Ok(json!([]));
        };
        let mut safe: Vec<Value> = providers
            .iter()
            .filter_map(|provider| {
                let object = provider.as_object()?;
                if !object.get("id").is_some_and(Value::is_string)
                    || !object.get("name").is_some_and(Value::is_string)
                    || !object.get("baseURL").is_some_and(Value::is_string)
                    || !object.get("models").is_some_and(Value::is_array)
                {
                    return None;
                }
                let mut metadata = Map::new();
                for key in ["id", "name", "baseURL"] {
                    metadata.insert(key.into(), object.get(key)?.clone());
                }
                metadata.insert(
                    "keyPreview".into(),
                    json!(object
                        .get("keyPreview")
                        .and_then(Value::as_str)
                        .filter(|preview| *preview == "已安全保存 Key")
                        .unwrap_or("需要重新填写 Key")),
                );
                let format = object
                    .get("apiFormat")
                    .and_then(Value::as_str)
                    .filter(|format| {
                        matches!(
                            *format,
                            "responses" | "chat_completions" | "anthropic_messages"
                        )
                    })
                    .unwrap_or("responses");
                metadata.insert("apiFormat".into(), json!(format));
                let selected = object
                    .get("selectedModel")
                    .or_else(|| object.get("model"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                metadata.insert("selectedModel".into(), json!(selected));
                metadata.insert(
                    "updatedAt".into(),
                    json!(object.get("updatedAt").and_then(Value::as_i64).unwrap_or(0)),
                );
                if let Some(tag) = object.get("tag").and_then(Value::as_str) {
                    metadata.insert("tag".into(), json!(tag));
                }
                let models = object
                    .get("models")?
                    .as_array()?
                    .iter()
                    .filter_map(|model| {
                        let source = model.as_object()?;
                        let custom_name = source.get("customName")?.as_str()?;
                        let model_name = source.get("model")?.as_str()?;
                        if custom_name.trim().is_empty() || model_name.trim().is_empty() {
                            return None;
                        }
                        let mut safe_model = Map::new();
                        safe_model.insert("customName".into(), json!(custom_name));
                        safe_model.insert("model".into(), json!(model_name));
                        if let Some(format) = source
                            .get("apiFormat")
                            .and_then(Value::as_str)
                            .filter(|format| {
                                matches!(
                                    *format,
                                    "responses" | "chat_completions" | "anthropic_messages"
                                )
                            })
                        {
                            safe_model.insert("apiFormat".into(), json!(format));
                        }
                        for key in ["supportsReasoning", "supportsImages"] {
                            if let Some(value) = source.get(key).and_then(Value::as_bool) {
                                safe_model.insert(key.into(), json!(value));
                            }
                        }
                        Some(Value::Object(safe_model))
                    })
                    .collect::<Vec<_>>();
                metadata.insert("models".into(), Value::Array(models));
                if let Some(failover) = object.get("failover").and_then(Value::as_object) {
                    if let (Some(enabled), Some(priority), Some(mappings)) = (
                        failover.get("enabled").and_then(Value::as_bool),
                        failover.get("priority").and_then(Value::as_i64),
                        failover.get("modelMappings").and_then(Value::as_object),
                    ) {
                        if let Some(safe_mappings) = mappings.iter()
                            .map(|(source, target)| target.as_str().map(|value| (source.clone(), json!(value))))
                            .collect::<Option<Map<String, Value>>>() {
                            metadata.insert("failover".into(), json!({
                                "enabled": enabled, "priority": priority, "modelMappings": safe_mappings,
                            }));
                        }
                    }
                }
                Some(Value::Object(metadata))
            })
            .collect();
        safe.sort_by_key(|provider| provider["updatedAt"].as_i64().unwrap_or(0));
        Ok(Value::Array(safe))
    }

    pub fn current_provider_id(&self) -> Result<Option<String>, CommandError> {
        let Some(payload) = read_json(&self.directory.join("providers.json"))? else {
            return Ok(None);
        };
        Ok(payload
            .as_object()
            .and_then(|object| object.get("currentId"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string))
    }

    pub(crate) fn provider_document(&self) -> Result<Value, CommandError> {
        Ok(read_json(&self.directory.join("providers.json"))?
            .unwrap_or_else(|| json!({ "providers": [], "currentId": "" })))
    }

    pub(crate) fn replace_provider_document(&self, document: &Value) -> Result<(), CommandError> {
        let _guard = self.write_lock.lock().map_err(io_error)?;
        write_json(
            &self.directory,
            &self.directory.join("providers.json"),
            document,
        )
    }

    pub(crate) fn migration_journal(&self) -> Result<Option<Value>, CommandError> {
        read_json(&self.directory.join("credential-migration-journal.json"))
    }

    pub(crate) fn write_migration_journal(&self, journal: &Value) -> Result<(), CommandError> {
        let _guard = self.write_lock.lock().map_err(io_error)?;
        write_json(
            &self.directory,
            &self.directory.join("credential-migration-journal.json"),
            journal,
        )?;
        #[cfg(unix)]
        fs::File::open(&self.directory)
            .and_then(|file| file.sync_all())
            .map_err(io_error)?;
        Ok(())
    }

    pub(crate) fn clear_migration_journal(&self) -> Result<(), CommandError> {
        let _guard = self.write_lock.lock().map_err(io_error)?;
        let path = self.directory.join("credential-migration-journal.json");
        if check_regular_file(&path)? {
            fs::remove_file(path).map_err(io_error)?;
        }
        Ok(())
    }

    pub(crate) fn assert_no_pending_migration(&self) -> Result<(), CommandError> {
        if self.migration_journal()?.is_some() {
            return Err(CommandError::new(
                "MIGRATION_RECOVERY_REQUIRED",
                "请重新导入加密迁移包，完成中断恢复后再修改供应商。",
            ));
        }
        Ok(())
    }

    pub(crate) fn credential_migration_completed(&self) -> Result<bool, CommandError> {
        Ok(self
            .read_settings()?
            .get("credentialMigration")
            .and_then(Value::as_object)
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            == Some("completed"))
    }

    pub(crate) fn mark_credential_migration_completed(
        &self,
        imported_provider_count: usize,
        imported_credential_count: usize,
        completed_at: i64,
    ) -> Result<(), CommandError> {
        self.update_settings([(
            "credentialMigration".into(),
            json!({
                "status": "completed",
                "schemaVersion": 1,
                "completedAt": completed_at,
                "providerCount": imported_provider_count,
                "credentialCount": imported_credential_count,
            }),
        )])
    }

    pub(crate) fn update_providers<T>(
        &self,
        operation: impl FnOnce(&mut Vec<Value>, &mut String) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let _guard = self.write_lock.lock().map_err(io_error)?;
        let destination = self.directory.join("providers.json");
        let payload = read_json(&destination)?;
        let mut document = match payload {
            None => Map::new(),
            Some(Value::Object(document)) => document,
            _ => {
                return Err(CommandError::new(
                    "INVALID_PROVIDERS",
                    "预览供应商文件格式无效。",
                ))
            }
        };
        let mut providers = match document.remove("providers") {
            None => Vec::new(),
            Some(Value::Array(providers)) => providers,
            _ => {
                return Err(CommandError::new(
                    "INVALID_PROVIDERS",
                    "预览供应商文件格式无效。",
                ))
            }
        };
        // Do not rewrite old embedded credentials while the import path is still unimplemented.
        if providers.iter().any(|provider| {
            provider.as_object().is_none_or(|item| {
                ["apiKey", "apiKeys", "keys"]
                    .iter()
                    .any(|key| item.contains_key(*key))
            })
        }) {
            return Err(CommandError::new(
                "LEGACY_CREDENTIALS",
                "请先迁移旧版供应商凭据。",
            ));
        }
        let mut current_id = document
            .get("currentId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let result = operation(&mut providers, &mut current_id)?;
        document.insert("providers".into(), Value::Array(providers));
        document.insert("currentId".into(), Value::String(current_id));
        write_json(&self.directory, &destination, &Value::Object(document))?;
        Ok(result)
    }
}

fn write_json(directory: &Path, destination: &Path, value: &Value) -> Result<(), CommandError> {
    ensure_private_directory(directory)?;
    check_regular_file(destination)?;
    let temporary = directory.join(format!(
        ".data.{}.{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed),
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(io_error)?;
        serde_json::to_writer_pretty(&mut file, value).map_err(io_error)?;
        file.write_all(b"\n").map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        replace_file(&temporary, destination).map_err(io_error)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_json(path: &Path) -> Result<Option<Value>, CommandError> {
    if !check_regular_file(path)? {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(io_error)?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|_| CommandError::new("INVALID_DATA", "预览数据文件无法解析。"))
}

#[cfg(not(windows))]
pub(crate) fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
pub(crate) fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !destination.exists() {
        return fs::rename(temporary, destination);
    }
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let temporary_wide: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    // ReplaceFileW retains the previous destination if replacement fails.
    let result = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            temporary_wide.as_ptr(),
            ptr::null(),
            0,
            ptr::null(),
            ptr::null(),
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn check_regular_file(path: &Path) -> Result<bool, CommandError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err(CommandError::new(
            "INVALID_DATA_PATH",
            "预览数据路径不是普通文件。",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

fn ensure_private_directory(path: &Path) -> Result<(), CommandError> {
    fs::create_dir_all(path).map_err(io_error)?;
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.file_type().is_dir() {
        return Err(CommandError::new(
            "INVALID_DATA_PATH",
            "预览数据目录不可用。",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
    }
    Ok(())
}

fn io_error(_: impl std::fmt::Debug) -> CommandError {
    CommandError::new("STORAGE_ERROR", "预览数据读写失败，请检查文件权限。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn isolated_store() -> (PathBuf, PreviewStore) {
        let root = std::env::temp_dir().join(format!(
            "cksw-preview-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        (root.clone(), PreviewStore::new(root))
    }

    #[test]
    fn preserves_existing_settings_and_survives_reopen() {
        let (root, store) = isolated_store();
        store
            .update_settings([("routeEnabled".into(), json!(false))])
            .unwrap();
        store
            .update_settings([("appTheme".into(), json!("dark"))])
            .unwrap();
        let reopened = PreviewStore::new(root.clone());
        let settings = reopened.read_settings().unwrap();
        assert_eq!(settings["routeEnabled"], false);
        assert_eq!(settings["appTheme"], "dark");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(root.join("settings.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_settings_do_not_get_overwritten() {
        let (root, store) = isolated_store();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("settings.json"), "not json").unwrap();
        assert!(store
            .update_settings([("appTheme".into(), json!("dark"))])
            .is_err());
        assert_eq!(
            fs::read_to_string(root.join("settings.json")).unwrap(),
            "not json"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_legacy_provider_metadata_without_exposing_embedded_keys() {
        let (root, store) = isolated_store();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("providers.json"), json!({ "providers": [
            {"id":"second","name":"Second","baseURL":"https://example.com","models":[],"updatedAt":2,"apiKey":"secret","keyPreview":"secret-preview","keys":[{"apiKey":"hidden"}]},
            {"id":"first","name":"First","baseURL":"https://example.com","models":[],"updatedAt":1}
        ], "currentId": "second" }).to_string()).unwrap();
        let providers = store.list_providers().unwrap();
        assert_eq!(providers[0]["id"], "first");
        assert_eq!(providers[1]["id"], "second");
        assert!(!providers.to_string().contains("secret"));
        assert!(!providers.to_string().contains("hidden"));
        assert!(!providers.to_string().contains("secret-preview"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_updates_keep_both_settings() {
        let (root, store) = isolated_store();
        std::thread::scope(|threads| {
            threads.spawn(|| {
                store
                    .update_settings([("appLanguage".into(), json!("en"))])
                    .unwrap()
            });
            threads.spawn(|| {
                store
                    .update_settings([("appTheme".into(), json!("dark"))])
                    .unwrap()
            });
        });
        let reopened = PreviewStore::new(root.clone());
        let settings = reopened.read_settings().unwrap();
        assert_eq!(settings["appLanguage"], "en");
        assert_eq!(settings["appTheme"], "dark");
        fs::remove_dir_all(root).unwrap();
    }
}
