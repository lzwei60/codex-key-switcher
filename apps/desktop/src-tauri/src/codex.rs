use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::{json, Value};

use crate::{
    commands::CommandError,
    providers,
    storage::{replace_file, PreviewStore},
};
use toml_edit::{value, DocumentMut, Item, Table};

const BACKUP_SUFFIX: &str = ".codex-key-switcher.bak";

pub struct CodexState {
    home_directory: PathBuf,
    write_lock: Mutex<()>,
}

impl CodexState {
    pub fn new(home_directory: PathBuf) -> Self {
        Self {
            home_directory,
            write_lock: Mutex::new(()),
        }
    }

    pub fn prepare_sandbox(&self, store: &PreviewStore) -> Result<String, CommandError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| CommandError::new("CODEX_STATE", "Codex 配置状态不可用。"))?;
        if self.restore_available(store)? {
            return Err(CommandError::new(
                "CODEX_RESTORE_REQUIRED",
                "请先恢复已有的隔离 Codex 配置。",
            ));
        }
        store.ensure_preview_directory()?;
        let directory = store.preview_data_directory().join("codex-sandbox");
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_dir() => (),
            Ok(_) => {
                return Err(CommandError::new(
                    "INVALID_CODEX_DIRECTORY",
                    "隔离目录不可用。",
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&directory).map_err(io_error)?;
            }
            Err(error) => return Err(io_error(error)),
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(io_error)?;
        }
        for (name, contents) in [
            ("config.toml", b"".as_slice()),
            ("auth.json", b"{}\n".as_slice()),
        ] {
            let path = directory.join(name);
            if !regular_file_exists(&path)? {
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&path).map_err(io_error)?;
                file.write_all(contents).map_err(io_error)?;
                file.sync_all().map_err(io_error)?;
            }
        }
        let result = directory.to_string_lossy().into_owned();
        store.update_settings([("codexConfigDir".into(), serde_json::json!(result))])?;
        Ok(result)
    }

    pub fn select_directory(
        &self,
        store: &PreviewStore,
        directory: &str,
    ) -> Result<String, CommandError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| CommandError::new("CODEX_STATE", "Codex 配置状态不可用。"))?;
        let previous = self.configured_directory(store)?;
        if previous != directory && self.restore_available(store)? {
            return Err(CommandError::new(
                "CODEX_RESTORE_REQUIRED",
                "请先恢复已有的隔离 Codex 配置。",
            ));
        }
        if directory != "~/.codex" {
            let resolved = self.resolve_directory(directory)?;
            validate_directory(store, &resolved)?;
        }
        store.update_settings([("codexConfigDir".into(), serde_json::json!(directory))])?;
        Ok(directory.to_string())
    }

    pub fn sync_direct_provider(
        &self,
        store: &PreviewStore,
        backend: &impl crate::credentials::SecretBackend,
    ) -> Result<(), CommandError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| CommandError::new("CODEX_STATE", "Codex 配置状态不可用。"))?;
        let directory = self.explicit_directory(store)?;
        let provider = providers::current_gateway_provider(store, backend)?
            .ok_or_else(|| CommandError::new("PROVIDER_NOT_FOUND", "请先选择一个供应商。"))?;
        let current_id = store.current_provider_id()?.unwrap_or_default();
        let listed = store.list_providers()?;
        let current = listed
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == current_id))
            .ok_or_else(|| CommandError::new("PROVIDER_NOT_FOUND", "请先选择一个供应商。"))?;
        if provider.api_format != "responses"
            || current["models"].as_array().is_none_or(|models| {
                models.iter().any(|model| {
                    model["apiFormat"]
                        .as_str()
                        .unwrap_or(current["apiFormat"].as_str().unwrap_or("responses"))
                        != "responses"
                })
            })
        {
            return Err(CommandError::new(
                "DIRECT_PROTOCOL_UNSUPPORTED",
                "直连配置仅支持 Responses 格式供应商。",
            ));
        }
        let catalog = write_model_catalog(store, current, "direct_provider")?;
        ManagedCodexFiles::new(directory).apply_provider(
            &provider.base_url,
            &provider.api_key,
            &provider.model,
            Some(&catalog),
        )
    }

    pub fn sync_gateway(
        &self,
        store: &PreviewStore,
        endpoint: &str,
        local_gateway_api_key: &str,
    ) -> Result<(), CommandError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| CommandError::new("CODEX_STATE", "Codex 配置状态不可用。"))?;
        let directory = self.explicit_directory(store)?;
        let current_id = store
            .current_provider_id()?
            .ok_or_else(|| CommandError::new("PROVIDER_NOT_FOUND", "请先选择一个供应商。"))?;
        let providers = store.list_providers()?;
        let provider = providers
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == current_id))
            .ok_or_else(|| CommandError::new("PROVIDER_NOT_FOUND", "请先选择一个供应商。"))?;
        let selected = provider["selectedModel"].as_str().unwrap_or("");
        let model_entry = provider["models"]
            .as_array()
            .and_then(|models| {
                models
                    .iter()
                    .find(|model| model["customName"] == selected || model["model"] == selected)
            })
            .or_else(|| {
                provider["models"]
                    .as_array()
                    .and_then(|models| models.first())
            })
            .ok_or_else(|| CommandError::new("MODEL_NOT_FOUND", "当前供应商没有可用模型。"))?;
        let model = providers::catalog_slug_for_model(provider, model_entry)
            .ok_or_else(|| CommandError::new("MODEL_NOT_FOUND", "当前供应商没有可用模型。"))?;
        let catalog = write_model_catalog(store, provider, "local_gateway")?;
        ManagedCodexFiles::new(directory).apply_provider(
            endpoint,
            local_gateway_api_key,
            &model,
            Some(&catalog),
        )
    }

    pub fn restore(&self, store: &PreviewStore) -> Result<(), CommandError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| CommandError::new("CODEX_STATE", "Codex 配置状态不可用。"))?;
        let Some(directory) = self.optional_directory(store)? else {
            return Ok(());
        };
        ManagedCodexFiles::new(directory).restore()
    }

    pub fn configured_directory(&self, store: &PreviewStore) -> Result<String, CommandError> {
        let settings = store.read_settings()?;
        Ok(settings
            .get("codexConfigDir")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("~/.codex")
            .to_string())
    }

    pub fn restore_available(&self, store: &PreviewStore) -> Result<bool, CommandError> {
        let Some(directory) = self.optional_directory(store)? else {
            return Ok(false);
        };
        ManagedCodexFiles::new(directory).backup_available()
    }

    pub fn uses_endpoint(
        &self,
        store: &PreviewStore,
        endpoint: &str,
    ) -> Result<bool, CommandError> {
        let Some(directory) = self.optional_directory(store)? else {
            return Ok(false);
        };
        ManagedCodexFiles::new(directory).config_contains(endpoint)
    }

    fn explicit_directory(&self, store: &PreviewStore) -> Result<PathBuf, CommandError> {
        let configured = self.configured_directory(store)?;
        if configured == "~/.codex" || configured.is_empty() {
            return Err(CommandError::new(
                "CODEX_DIRECTORY_NOT_EXPLICIT",
                "Tauri 预览版必须先选择隔离的 Codex 配置目录。",
            ));
        }
        let directory = self.resolve_directory(&configured)?;
        validate_directory(store, &directory)?;
        Ok(directory)
    }

    fn optional_directory(&self, store: &PreviewStore) -> Result<Option<PathBuf>, CommandError> {
        let configured = self.configured_directory(store)?;
        if configured == "~/.codex" || configured.is_empty() {
            return Ok(None);
        }
        let directory = self.resolve_directory(&configured)?;
        validate_directory(store, &directory)?;
        Ok(Some(directory))
    }

    fn resolve_directory(&self, configured: &str) -> Result<PathBuf, CommandError> {
        let directory = if configured == "~" {
            self.home_directory.clone()
        } else if let Some(relative) = configured.strip_prefix("~/") {
            self.home_directory.join(relative)
        } else {
            PathBuf::from(configured)
        };
        if !directory.is_absolute() {
            return Err(CommandError::new(
                "INVALID_CODEX_DIRECTORY",
                "Codex 配置目录必须是绝对路径或 ~/ 路径。",
            ));
        }
        Ok(directory)
    }
}

fn write_model_catalog(
    store: &PreviewStore,
    provider: &Value,
    mode: &str,
) -> Result<String, CommandError> {
    let models = provider["models"]
        .as_array()
        .ok_or_else(|| CommandError::new("MODEL_NOT_FOUND", "当前供应商没有可用模型。"))?;
    if models.is_empty() {
        return Err(CommandError::new(
            "MODEL_NOT_FOUND",
            "当前供应商没有可用模型。",
        ));
    }
    let cache = read_model_cache(store)?;
    let catalog_models = models
        .iter()
        .enumerate()
        .filter_map(|(index, model)| catalog_model(provider, model, mode, index, &cache))
        .collect::<Vec<_>>();
    if catalog_models.is_empty() {
        return Err(CommandError::new(
            "MODEL_NOT_FOUND",
            "当前供应商没有可写入 Codex 的模型。",
        ));
    }
    let mut payload = json!({
        "fetched_at": chrono::Utc::now().to_rfc3339(),
        "client_version": cache.client_version,
        "models": catalog_models,
    });
    if let Some(etag) = cache.etag {
        payload["etag"] = json!(etag);
    }
    let path = store
        .preview_data_directory()
        .join("model-catalogs")
        .join("current.json");
    write_catalog_json(&path, &payload)?;
    Ok(path.to_string_lossy().into_owned())
}

struct ModelCache {
    client_version: String,
    etag: Option<String>,
    templates: Vec<Value>,
}

fn read_model_cache(store: &PreviewStore) -> Result<ModelCache, CommandError> {
    let path = store
        .configured_codex_directory_for_catalog()
        .join("models_cache.json");
    let payload = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    let templates = payload["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter(|model| model.is_object())
                .cloned()
                .collect::<Vec<_>>()
        })
        .filter(|models| !models.is_empty())
        .unwrap_or_else(|| vec![fallback_catalog_model()]);
    Ok(ModelCache {
        client_version: payload["client_version"]
            .as_str()
            .unwrap_or("codex-key-switcher")
            .to_string(),
        etag: payload["etag"].as_str().map(str::to_string),
        templates,
    })
}

fn catalog_model(
    provider: &Value,
    model: &Value,
    mode: &str,
    index: usize,
    cache: &ModelCache,
) -> Option<Value> {
    let upstream = model["model"].as_str()?.trim();
    let display = model["customName"].as_str()?.trim();
    if upstream.is_empty() || display.is_empty() {
        return None;
    }
    let template = cache
        .templates
        .iter()
        .find(|candidate| candidate["slug"].as_str() == Some(upstream))
        .cloned()
        .unwrap_or_else(fallback_catalog_model);
    let slug = if mode == "direct_provider" {
        upstream.to_string()
    } else {
        providers::catalog_slug_for_model(provider, model)?
    };
    let supports_images = model["supportsImages"].as_bool().unwrap_or_else(|| {
        model["apiFormat"]
            .as_str()
            .or_else(|| provider["apiFormat"].as_str())
            == Some("responses")
    });
    let mut result = fallback_catalog_model();
    if let (Some(target), Some(source)) = (result.as_object_mut(), template.as_object()) {
        target.extend(source.clone());
    }
    result["slug"] = json!(slug);
    result["display_name"] = json!(display);
    result["description"] = json!(format!(
        "{} / {}",
        provider["name"].as_str().unwrap_or("Provider"),
        display
    ));
    result["visibility"] = json!("list");
    result["supported_in_api"] = json!(true);
    result["priority"] = json!(std::cmp::max(1, 100_i64 - index as i64));
    result["input_modalities"] = if supports_images {
        json!(["text", "image"])
    } else {
        json!(["text"])
    };
    if model["supportsReasoning"] == false {
        result["default_reasoning_level"] = json!("none");
        result["supported_reasoning_levels"] =
            json!([{"effort":"none","description":"Reasoning parameters disabled"}]);
        result["supports_reasoning_summaries"] = json!(false);
    }
    Some(result)
}

fn fallback_catalog_model() -> Value {
    json!({
        "slug": "gpt-4.1", "display_name": "Codex model", "description": "",
        "default_reasoning_level": "medium",
        "supported_reasoning_levels": [
            {"effort":"low","description":"Fast responses with lighter reasoning"},
            {"effort":"medium","description":"Balances speed and reasoning depth"},
            {"effort":"high","description":"Greater reasoning depth for complex tasks"}
        ],
        "shell_type":"shell_command", "visibility":"list", "supported_in_api":true,
        "priority":1, "additional_speed_tiers":[], "service_tiers":[], "upgrade":null,
        "supports_reasoning_summaries":true, "default_reasoning_summary":"none",
        "support_verbosity":true, "default_verbosity":"low", "apply_patch_tool_type":"freeform",
        "web_search_tool_type":"text_and_image", "truncation_policy":{"mode":"tokens","limit":10000},
        "base_instructions":"", "model_messages":null, "experimental_supported_tools":[],
        "supports_image_detail_original":false, "effective_context_window_percent":95,
        "supports_parallel_tool_calls":true, "input_modalities":["text"], "supports_search_tool":true
    })
}

fn write_catalog_json(path: &Path, payload: &Value) -> Result<(), CommandError> {
    let directory = path
        .parent()
        .ok_or_else(|| CommandError::new("MODEL_CATALOG_WRITE_FAILED", "模型目录路径无效。"))?;
    fs::create_dir_all(directory).map_err(io_error)?;
    let temporary = directory.join(format!(".catalog.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(io_error)?;
        serde_json::to_writer_pretty(&mut file, payload).map_err(|_| io_error(()))?;
        file.write_all(b"\n").map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        replace_file(&temporary, path).map_err(io_error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub struct ManagedCodexFiles {
    directory: PathBuf,
}

impl ManagedCodexFiles {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub fn apply(&self, config: &str, auth: &str) -> Result<(), CommandError> {
        self.apply_with_writer(config, auth, write_private)
    }

    fn apply_with_writer(
        &self,
        config: &str,
        auth: &str,
        mut write: impl FnMut(&Path, &[u8]) -> Result<(), CommandError>,
    ) -> Result<(), CommandError> {
        let (config_path, auth_path) = self.paths();
        let original_config = read_file(&config_path)?;
        let original_auth = read_file(&auth_path)?;
        let (config_backup, auth_backup) = self.backups();
        let has_config_backup = regular_file_exists(&config_backup)?;
        let has_auth_backup = regular_file_exists(&auth_backup)?;
        if has_config_backup != has_auth_backup {
            return Err(CommandError::new(
                "INCOMPLETE_CODEX_BACKUP",
                "Codex 配置备份不完整。",
            ));
        }
        let created_backups = !has_config_backup;
        if created_backups {
            create_backup(&config_backup, &original_config)?;
            if let Err(error) = create_backup(&auth_backup, &original_auth) {
                remove_backups(&config_backup, &auth_backup)?;
                return Err(error);
            }
        }
        if let Err(error) = write(&config_path, config.as_bytes()) {
            if created_backups {
                remove_backups(&config_backup, &auth_backup)?;
            }
            return Err(error);
        }
        if let Err(error) = write(&auth_path, auth.as_bytes()) {
            write_private(&config_path, &original_config)
                .map_err(|_| CommandError::new("CODEX_ROLLBACK_FAILED", "Codex 配置回滚失败。"))?;
            if created_backups {
                remove_backups(&config_backup, &auth_backup)?;
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn apply_provider(
        &self,
        endpoint: &str,
        api_key: &str,
        model: &str,
        catalog: Option<&str>,
    ) -> Result<(), CommandError> {
        let (config_path, auth_path) = self.paths();
        let config = render_config(
            &String::from_utf8(read_file(&config_path)?).map_err(|_| invalid_config())?,
            endpoint,
            model,
            catalog,
        )?;
        let auth = render_auth(&read_file(&auth_path)?, api_key)?;
        self.apply(&config, &auth)
    }

    pub fn restore(&self) -> Result<(), CommandError> {
        let (config_backup, auth_backup) = self.backups();
        let config_exists = regular_file_exists(&config_backup)?;
        let auth_exists = regular_file_exists(&auth_backup)?;
        if !config_exists && !auth_exists {
            return Ok(());
        }
        if !config_exists || !auth_exists {
            return Err(CommandError::new(
                "INCOMPLETE_CODEX_BACKUP",
                "Codex 配置备份不完整。",
            ));
        }
        let config = read_file(&config_backup)?;
        let auth = read_file(&auth_backup)?;
        let (config_path, auth_path) = self.paths();
        let current_config = read_file(&config_path)?;
        let current_auth = read_file(&auth_path)?;
        write_private(&config_path, &config)?;
        if let Err(error) = write_private(&auth_path, &auth) {
            write_private(&config_path, &current_config)
                .map_err(|_| CommandError::new("CODEX_ROLLBACK_FAILED", "Codex 配置回滚失败。"))?;
            write_private(&auth_path, &current_auth)
                .map_err(|_| CommandError::new("CODEX_ROLLBACK_FAILED", "Codex 配置回滚失败。"))?;
            return Err(error);
        }
        fs::remove_file(config_backup).map_err(io_error)?;
        fs::remove_file(auth_backup).map_err(io_error)?;
        Ok(())
    }

    pub fn backup_available(&self) -> Result<bool, CommandError> {
        let (config_backup, auth_backup) = self.backups();
        let config_exists = regular_file_exists(&config_backup)?;
        let auth_exists = regular_file_exists(&auth_backup)?;
        if config_exists != auth_exists {
            return Err(CommandError::new(
                "INCOMPLETE_CODEX_BACKUP",
                "Codex 配置备份不完整。",
            ));
        }
        Ok(config_exists)
    }

    pub fn config_contains(&self, endpoint: &str) -> Result<bool, CommandError> {
        let (config_path, _) = self.paths();
        if !regular_file_exists(&config_path)? {
            return Ok(false);
        }
        Ok(String::from_utf8(read_file(&config_path)?)
            .map_err(|_| invalid_config())?
            .contains(endpoint))
    }

    fn paths(&self) -> (PathBuf, PathBuf) {
        (
            self.directory.join("config.toml"),
            self.directory.join("auth.json"),
        )
    }

    fn backups(&self) -> (PathBuf, PathBuf) {
        let (config, auth) = self.paths();
        (
            PathBuf::from(format!("{}{BACKUP_SUFFIX}", config.display())),
            PathBuf::from(format!("{}{BACKUP_SUFFIX}", auth.display())),
        )
    }
}

fn remove_backups(config: &Path, auth: &Path) -> Result<(), CommandError> {
    for path in [config, auth] {
        if regular_file_exists(path)? {
            fs::remove_file(path).map_err(io_error)?;
        }
    }
    Ok(())
}

fn render_config(
    source: &str,
    endpoint: &str,
    model: &str,
    catalog: Option<&str>,
) -> Result<String, CommandError> {
    let parsed = url::Url::parse(endpoint).map_err(|_| invalid_config())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || model.trim().is_empty()
    {
        return Err(invalid_config());
    }
    let mut document = source
        .parse::<DocumentMut>()
        .map_err(|_| invalid_config())?;
    let provider = document
        .get("model_provider")
        .and_then(Item::as_str)
        .filter(|name| !name.is_empty() && *name != "codex-key-switcher")
        .unwrap_or("openai")
        .to_string();
    document["model_provider"] = value(provider.as_str());
    document["model"] = value(model);
    document["model_reasoning_effort"] = value("high");
    if let Some(catalog) = catalog {
        document["model_catalog_json"] = value(catalog);
    }
    if !document.contains_key("model_providers") {
        document["model_providers"] = Item::Table(Table::new());
    }
    let providers = document["model_providers"]
        .as_table_mut()
        .ok_or_else(invalid_config)?;
    if !providers.contains_key(&provider) {
        providers[&provider] = Item::Table(Table::new());
    }
    let target = providers[&provider]
        .as_table_mut()
        .ok_or_else(invalid_config)?;
    target["name"] = value(provider.as_str());
    target["base_url"] = value(endpoint);
    target["wire_api"] = value("responses");
    Ok(document.to_string())
}

fn render_auth(source: &[u8], api_key: &str) -> Result<String, CommandError> {
    if api_key.trim().is_empty() {
        return Err(CommandError::new("MISSING_CREDENTIAL", "缺少 API Key。"));
    }
    let mut auth: serde_json::Value = serde_json::from_slice(source)
        .map_err(|_| CommandError::new("INVALID_CODEX_AUTH", "auth.json 不是合法 JSON 对象。"))?;
    let fields = auth
        .as_object_mut()
        .ok_or_else(|| CommandError::new("INVALID_CODEX_AUTH", "auth.json 不是合法 JSON 对象。"))?;
    fields.insert("auth_mode".into(), serde_json::json!("apikey"));
    fields.insert("OPENAI_API_KEY".into(), serde_json::json!(api_key));
    serde_json::to_string_pretty(&auth)
        .map(|value| format!("{value}\n"))
        .map_err(|_| CommandError::new("INVALID_CODEX_AUTH", "auth.json 无法写入。"))
}

fn invalid_config() -> CommandError {
    CommandError::new("INVALID_CODEX_CONFIG", "Codex TOML 配置无效。")
}

fn regular_file_exists(path: &Path) -> Result<bool, CommandError> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.file_type().is_file() => Ok(true),
        Ok(_) => Err(CommandError::new(
            "INVALID_CODEX_PATH",
            "Codex 配置路径无效。",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

fn validate_directory(store: &PreviewStore, path: &Path) -> Result<(), CommandError> {
    let root = fs::canonicalize(store.preview_data_directory()).map_err(|_| {
        CommandError::new("MISSING_PREVIEW_DIRECTORY", "Tauri 预览数据目录不存在。")
    })?;
    let resolved = fs::canonicalize(path)
        .map_err(|_| CommandError::new("MISSING_CODEX_DIRECTORY", "Codex 配置目录不存在。"))?;
    if resolved != root.join("codex-sandbox") {
        return Err(CommandError::new(
            "CODEX_DIRECTORY_NOT_ISOLATED",
            "仅允许使用 Tauri 预览数据目录内的 codex-sandbox。",
        ));
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(CommandError::new(
            "INVALID_CODEX_DIRECTORY",
            "Codex 配置目录不是普通目录。",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(CommandError::new(
            "MISSING_CODEX_DIRECTORY",
            "Codex 配置目录不存在。",
        )),
        Err(error) => Err(io_error(error)),
    }
}

fn read_file(path: &Path) -> Result<Vec<u8>, CommandError> {
    if !regular_file_exists(path)? {
        return Err(CommandError::new(
            "MISSING_CODEX_FILE",
            "Codex 配置文件不存在。",
        ));
    }
    fs::read(path).map_err(io_error)
}

fn create_backup(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    let temporary = path.with_extension(format!(
        "backup.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary).map_err(io_error)?;
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        // Publish a complete snapshot without ever replacing an existing backup.
        fs::hard_link(&temporary, path).map_err(io_error)
    })();
    if temporary.exists() {
        fs::remove_file(&temporary).map_err(io_error)?;
    }
    result
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    regular_file_exists(path)?;
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
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
        file.write_all(bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        replace_file(&temporary, path).map_err(io_error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn io_error(_: impl std::fmt::Debug) -> CommandError {
    CommandError::new("CODEX_FILE_ERROR", "Codex 配置文件读写失败。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{credentials::SecretBackend, providers::ProviderInput};
    use std::{collections::HashMap, process::Command, sync::Mutex};

    #[derive(Default)]
    struct MemorySecrets(Mutex<HashMap<String, String>>);

    impl SecretBackend for MemorySecrets {
        fn set(&self, id: &str, value: &str) -> Result<(), CommandError> {
            self.0.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<Option<String>, CommandError> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        fn delete(&self, id: &str) -> Result<(), CommandError> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn preview_fixture() -> (PathBuf, PreviewStore, CodexState, MemorySecrets) {
        let root =
            std::env::temp_dir().join(format!("cksw-codex-preview-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        let codex = CodexState::new(root.clone());
        let secrets = MemorySecrets::default();
        (root, store, codex, secrets)
    }

    fn insert_provider(store: &PreviewStore, secrets: &MemorySecrets) {
        let input: ProviderInput = serde_json::from_value(serde_json::json!({
            "id": "one", "name": "Example", "baseURL": "https://example.com/v1",
            "apiFormat": "responses", "models": [{ "customName": "Alias", "model": "upstream-model" }],
            "selectedModel": "Alias", "apiKey": "synthetic-secret"
        })).unwrap();
        crate::providers::save_provider(store, secrets, input).unwrap();
    }

    fn isolated() -> (PathBuf, ManagedCodexFiles) {
        let root = std::env::temp_dir().join(format!("cksw-codex-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("config.toml"), "model = \"original\"\n").unwrap();
        fs::write(root.join("auth.json"), "{}\n").unwrap();
        (root.clone(), ManagedCodexFiles::new(root))
    }

    #[test]
    fn sandbox_sync_restores_original_files_and_rejects_default_directory() {
        let (root, store, codex, secrets) = preview_fixture();
        insert_provider(&store, &secrets);
        assert_eq!(
            codex
                .sync_direct_provider(&store, &secrets)
                .unwrap_err()
                .code(),
            "CODEX_DIRECTORY_NOT_EXPLICIT"
        );
        let sandbox = codex.prepare_sandbox(&store).unwrap();
        let sandbox = PathBuf::from(sandbox);
        fs::write(sandbox.join("config.toml"), "model = \"original\"\n").unwrap();
        fs::write(sandbox.join("auth.json"), "{\"other\":true}\n").unwrap();
        codex.sync_direct_provider(&store, &secrets).unwrap();
        codex.sync_direct_provider(&store, &secrets).unwrap();
        let config = fs::read_to_string(sandbox.join("config.toml")).unwrap();
        assert!(config.contains("upstream-model"));
        assert!(config.contains("https://example.com/v1"));
        assert!(config.contains("model_catalog_json"));
        let catalog: Value =
            serde_json::from_slice(&fs::read(root.join("model-catalogs/current.json")).unwrap())
                .unwrap();
        assert_eq!(catalog["models"][0]["slug"], "upstream-model");
        assert_eq!(
            fs::read_to_string(sandbox.join("config.toml.codex-key-switcher.bak")).unwrap(),
            "model = \"original\"\n"
        );
        assert!(codex.restore_available(&store).unwrap());
        codex.restore(&store).unwrap();
        assert_eq!(
            fs::read_to_string(sandbox.join("config.toml")).unwrap(),
            "model = \"original\"\n"
        );
        assert_eq!(
            fs::read_to_string(sandbox.join("auth.json")).unwrap(),
            "{\"other\":true}\n"
        );
        assert!(!codex.restore_available(&store).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gateway_sync_writes_loopback_endpoint_and_restores_original_files() {
        let (root, store, codex, secrets) = preview_fixture();
        insert_provider(&store, &secrets);
        let sandbox = PathBuf::from(codex.prepare_sandbox(&store).unwrap());
        fs::write(sandbox.join("config.toml"), "model = \"original\"\n").unwrap();
        fs::write(sandbox.join("auth.json"), "{}\n").unwrap();

        codex
            .sync_gateway(&store, "http://127.0.0.1:4567/v1", "preview-gateway-key")
            .unwrap();
        let config = fs::read_to_string(sandbox.join("config.toml")).unwrap();
        let auth = fs::read_to_string(sandbox.join("auth.json")).unwrap();
        assert!(config.contains("http://127.0.0.1:4567/v1"));
        assert!(config.contains("ks-one-alias"));
        assert!(auth.contains("preview-gateway-key"));
        let catalog: Value =
            serde_json::from_slice(&fs::read(root.join("model-catalogs/current.json")).unwrap())
                .unwrap();
        assert_eq!(catalog["models"][0]["slug"], "ks-one-alias");
        assert!(codex.restore_available(&store).unwrap());

        codex.restore(&store).unwrap();
        assert_eq!(
            fs::read_to_string(sandbox.join("config.toml")).unwrap(),
            "model = \"original\"\n"
        );
        assert_eq!(
            fs::read_to_string(sandbox.join("auth.json")).unwrap(),
            "{}\n"
        );
        assert!(!codex.restore_available(&store).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn catalog_generation_matches_shared_cross_runtime_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/model-catalog-blackbox.json"))
                .unwrap();
        let (root, store, codex, secrets) = preview_fixture();
        let input: ProviderInput = serde_json::from_value(fixture["provider"].clone()).unwrap();
        crate::providers::save_provider(&store, &secrets, input).unwrap();
        crate::providers::set_current_provider(&store, &secrets, "provider-12345678").unwrap();
        codex.prepare_sandbox(&store).unwrap();
        let sandbox = root.join("codex-sandbox");
        fs::write(
            sandbox.join("models_cache.json"),
            fixture["cache"].to_string(),
        )
        .unwrap();
        fs::write(sandbox.join("config.toml"), "model = \"original\"\n").unwrap();
        fs::write(sandbox.join("auth.json"), "{}\n").unwrap();

        codex
            .sync_gateway(&store, "http://127.0.0.1:4567/v1", "preview-gateway-key")
            .unwrap();
        let catalog: Value =
            serde_json::from_slice(&fs::read(root.join("model-catalogs/current.json")).unwrap())
                .unwrap();
        assert_eq!(
            catalog["client_version"],
            fixture["expected"]["clientVersion"]
        );
        assert_eq!(catalog["etag"], fixture["expected"]["etag"]);
        let local_slugs = catalog["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["slug"].clone())
            .collect::<Vec<_>>();
        assert_eq!(Value::Array(local_slugs), fixture["expected"]["localSlugs"]);
        assert_eq!(
            catalog["models"][0]["supported_reasoning_levels"],
            fixture["cache"]["models"][0]["supported_reasoning_levels"]
        );
        assert_eq!(catalog["models"][1]["default_reasoning_level"], "none");
        assert_eq!(catalog["models"][2]["input_modalities"], json!(["text"]));

        codex.restore(&store).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generated_catalog_loads_in_real_app_server_when_available() {
        let Ok(binary) = std::env::var("CODEX_BINARY") else {
            return;
        };
        let (root, store, _, _) = preview_fixture();
        let provider = json!({
            "id": "catalog-test", "name": "Provider", "apiFormat": "responses",
            "models": [
                {"customName": "Reasoning", "model": "reasoning"},
                {"customName": "Plain", "model": "plain", "supportsReasoning": false,
                 "supportsImages": false}
            ]
        });
        let catalog = write_model_catalog(&store, &provider, "local_gateway").unwrap();
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/verify-codex-catalog.mjs");
        let output = Command::new("node")
            .arg(&script)
            .arg(catalog)
            .env("CODEX_BINARY", &binary)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "app-server catalog check failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/model-catalog-blackbox.json"))
                .unwrap();
        fs::create_dir_all(root.join("codex-sandbox")).unwrap();
        fs::write(
            root.join("codex-sandbox/models_cache.json"),
            fixture["cache"].to_string(),
        )
        .unwrap();
        let cached_catalog =
            write_model_catalog(&store, &fixture["provider"], "local_gateway").unwrap();
        let output = Command::new("node")
            .arg(&script)
            .arg(cached_catalog)
            .env("CODEX_BINARY", &binary)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "cached app-server catalog check failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if std::env::var_os("CODEX_TURN_SMOKE").is_some() {
            let output = Command::new("node")
                .arg(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../../scripts/verify-codex-turn.mjs"),
                )
                .arg(root.join("model-catalogs/current.json"))
                .env("CODEX_BINARY", &binary)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "app-server turn smoke failed: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let direct_catalog =
            write_model_catalog(&store, &fixture["provider"], "direct_provider").unwrap();
        let output = Command::new("node")
            .arg(&script)
            .arg(direct_catalog)
            .env("CODEX_BINARY", &binary)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "direct app-server catalog check failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_external_directory_and_directory_change_with_active_backup() {
        let (root, store, codex, secrets) = preview_fixture();
        insert_provider(&store, &secrets);
        let outside = std::env::temp_dir().join(format!("cksw-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&outside).unwrap();
        assert_eq!(
            codex
                .select_directory(&store, outside.to_str().unwrap())
                .unwrap_err()
                .code(),
            "CODEX_DIRECTORY_NOT_ISOLATED"
        );
        codex.prepare_sandbox(&store).unwrap();
        codex.sync_direct_provider(&store, &secrets).unwrap();
        assert_eq!(
            codex
                .select_directory(&store, "~/.codex")
                .unwrap_err()
                .code(),
            "CODEX_RESTORE_REQUIRED"
        );
        codex.restore(&store).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn mixed_protocol_provider_cannot_be_applied_to_direct_sandbox() {
        let (root, store, codex, secrets) = preview_fixture();
        let input: ProviderInput = serde_json::from_value(serde_json::json!({
            "id": "one", "name": "Mixed", "baseURL": "https://example.com/v1",
            "apiFormat": "responses", "models": [
                { "customName": "First", "model": "first" },
                { "customName": "Second", "model": "second", "apiFormat": "chat_completions" }
            ],
            "selectedModel": "First", "apiKey": "synthetic-secret"
        }))
        .unwrap();
        crate::providers::save_provider(&store, &secrets, input).unwrap();
        let sandbox = PathBuf::from(codex.prepare_sandbox(&store).unwrap());
        assert_eq!(
            codex
                .sync_direct_provider(&store, &secrets)
                .unwrap_err()
                .code(),
            "DIRECT_PROTOCOL_UNSUPPORTED"
        );
        assert!(!sandbox.join("config.toml.codex-key-switcher.bak").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn sandbox_symlinked_auth_is_rejected_before_writing() {
        use std::os::unix::fs::symlink;
        let (root, store, codex, secrets) = preview_fixture();
        insert_provider(&store, &secrets);
        let sandbox = PathBuf::from(codex.prepare_sandbox(&store).unwrap());
        fs::remove_file(sandbox.join("auth.json")).unwrap();
        symlink(sandbox.join("outside-auth.json"), sandbox.join("auth.json")).unwrap();
        assert!(codex.sync_direct_provider(&store, &secrets).is_err());
        assert!(!sandbox.join("config.toml.codex-key-switcher.bak").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn first_snapshot_survives_repeated_apply_and_restore() {
        let (root, files) = isolated();
        files
            .apply(
                "model = \"first\"\n",
                "{\"OPENAI_API_KEY\":\"synthetic\"}\n",
            )
            .unwrap();
        files
            .apply(
                "model = \"second\"\n",
                "{\"OPENAI_API_KEY\":\"synthetic2\"}\n",
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("config.toml.codex-key-switcher.bak")).unwrap(),
            "model = \"original\"\n"
        );
        files.restore().unwrap();
        assert_eq!(
            fs::read_to_string(root.join("config.toml")).unwrap(),
            "model = \"original\"\n"
        );
        assert_eq!(fs::read_to_string(root.join("auth.json")).unwrap(), "{}\n");
        assert!(!root.join("config.toml.codex-key-switcher.bak").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_backup_fails_without_modifying_config() {
        let (root, files) = isolated();
        fs::write(root.join("config.toml.codex-key-switcher.bak"), "original").unwrap();
        let before = fs::read(root.join("config.toml")).unwrap();
        assert!(files.apply("model = \"other\"\n", "{}\n").is_err());
        assert!(files.restore().is_err());
        assert_eq!(fs::read(root.join("config.toml")).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creating_a_backup_never_overwrites_an_existing_snapshot() {
        let (root, _files) = isolated();
        let backup = root.join("config.toml.codex-key-switcher.bak");
        fs::write(&backup, "original snapshot").unwrap();
        assert!(create_backup(&backup, b"replacement").is_err());
        assert_eq!(fs::read(&backup).unwrap(), b"original snapshot");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn updates_only_top_level_model_and_active_provider() {
        let (root, files) = isolated();
        fs::write(root.join("config.toml"), "model = \"before\"\nmodel_provider = \"custom\"\n\n[model_providers.custom]\nbase_url = \"https://old.example/v1\"\n\n[unrelated]\nmodel = \"unchanged\"\n").unwrap();
        fs::write(root.join("auth.json"), "{\"other\":\"preserved\"}\n").unwrap();
        files
            .apply_provider(
                "http://127.0.0.1:3456/v1",
                "synthetic-key",
                "next",
                Some("/isolated/catalog.json"),
            )
            .unwrap();
        let config = fs::read_to_string(root.join("config.toml")).unwrap();
        let parsed = config.parse::<DocumentMut>().unwrap();
        assert_eq!(parsed["model"].as_str(), Some("next"));
        assert_eq!(
            parsed["model_catalog_json"].as_str(),
            Some("/isolated/catalog.json")
        );
        assert_eq!(
            parsed["model_providers"]["custom"]["base_url"].as_str(),
            Some("http://127.0.0.1:3456/v1")
        );
        assert_eq!(parsed["unrelated"]["model"].as_str(), Some("unchanged"));
        let auth: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("auth.json")).unwrap()).unwrap();
        assert_eq!(auth["OPENAI_API_KEY"], "synthetic-key");
        assert_eq!(auth["other"], "preserved");
        files.restore().unwrap();
        assert!(fs::read_to_string(root.join("config.toml"))
            .unwrap()
            .contains("model = \"before\""));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_auth_fails_without_writing_config_or_backups() {
        let (root, files) = isolated();
        fs::write(root.join("auth.json"), "[]").unwrap();
        let before = fs::read(root.join("config.toml")).unwrap();
        assert!(files
            .apply_provider("http://127.0.0.1:3456/v1", "key", "model", None)
            .is_err());
        assert_eq!(fs::read(root.join("config.toml")).unwrap(), before);
        assert!(!root.join("config.toml.codex-key-switcher.bak").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_symlink_before_creating_backups() {
        let (root, files) = isolated();
        let original = fs::read(root.join("config.toml")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let auth = root.join("auth.json");
            fs::remove_file(&auth).unwrap();
            symlink(root.join("other.json"), &auth).unwrap();
            assert!(files.apply("model = \"changed\"\n", "{}\n").is_err());
            assert_eq!(fs::read(root.join("config.toml")).unwrap(), original);
            assert!(!root.join("config.toml.codex-key-switcher.bak").exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn auth_write_failure_restores_config_and_removes_new_backups() {
        let (root, files) = isolated();
        let original_config = fs::read(root.join("config.toml")).unwrap();
        let original_auth = fs::read(root.join("auth.json")).unwrap();
        let result = files.apply_with_writer(
            "model = \"changed\"\n",
            "{\"key\":\"synthetic\"}\n",
            |path, bytes| {
                if path.file_name().is_some_and(|name| name == "auth.json") {
                    return Err(CommandError::new("TEST_WRITE_FAILED", "模拟写入失败。"));
                }
                write_private(path, bytes)
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(root.join("config.toml")).unwrap(), original_config);
        assert_eq!(fs::read(root.join("auth.json")).unwrap(), original_auth);
        assert!(!root.join("config.toml.codex-key-switcher.bak").exists());
        assert!(!root.join("auth.json.codex-key-switcher.bak").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
