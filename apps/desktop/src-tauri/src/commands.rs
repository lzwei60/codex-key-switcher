use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::TcpListener;
use std::time::Instant;
use tauri::{AppHandle, State};

use crate::storage::PreviewStore;
use crate::{codex::CodexState, gateway::GatewayState};
use crate::{
    credentials::{SecretBackend, SystemKeyring},
    providers::ProviderInput,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelValidationInput {
    pub provider_id: Option<String>,
    pub api_key: Option<String>,
    pub base_url: String,
    pub api_format: String,
    pub model: ProviderModelValidationModel,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelValidationModel {
    pub model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelsListInput {
    pub provider_id: Option<String>,
    pub api_key: Option<String>,
    pub base_url: String,
    pub api_format: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

impl CommandError {
    pub(crate) fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            message,
            retryable: false,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    language: String,
    theme: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            language: "zh-Hans".into(),
            theme: "system".into(),
        }
    }
}

#[tauri::command]
pub fn app_startup_settings(store: State<'_, PreviewStore>) -> Result<Value, CommandError> {
    let settings = store.read_settings()?;
    let supported = startup_supported();
    Ok(json!({
        "supported": supported,
        "openAtLogin": settings.get("startupOpenAtLogin").and_then(Value::as_bool).unwrap_or(false),
        "openAsHidden": settings.get("startupOpenAsHidden").and_then(Value::as_bool).unwrap_or(false),
        "wasOpenedAtLogin": false,
        "status": "tauri-preview",
        "platform": platform(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSettingsInput {
    pub open_at_login: bool,
    pub open_as_hidden: bool,
}

#[tauri::command]
pub fn app_save_startup_settings(
    store: State<'_, PreviewStore>,
    input: StartupSettingsInput,
) -> Result<Value, CommandError> {
    if !startup_supported() && (input.open_at_login || input.open_as_hidden) {
        return Err(CommandError::new(
            "STARTUP_NOT_SUPPORTED",
            "当前平台不支持开机自启。",
        ));
    }
    configure_startup(input.open_at_login, input.open_as_hidden)?;
    store.update_settings([
        ("startupOpenAtLogin".into(), json!(input.open_at_login)),
        ("startupOpenAsHidden".into(), json!(input.open_as_hidden)),
    ])?;
    app_startup_settings(store)
}

fn startup_supported() -> bool {
    cfg!(target_os = "macos") || cfg!(target_os = "linux")
}

fn configure_startup(open_at_login: bool, open_as_hidden: bool) -> Result<(), CommandError> {
    if !startup_supported() {
        return Ok(());
    }
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| CommandError::new("STARTUP_CONFIG_FAILED", "无法确定当前用户目录。"))?;
    #[cfg(target_os = "macos")]
    let path = home.join("Library/LaunchAgents/com.codexkeyswitcher.tauri.preview.plist");
    #[cfg(target_os = "linux")]
    let path = home.join(".config/autostart/com.codexkeyswitcher.tauri.preview.desktop");
    if !open_at_login {
        match std::fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_symlink() || !metadata.file_type().is_file() =>
            {
                return Err(CommandError::new(
                    "STARTUP_CONFIG_FAILED",
                    "启动项文件类型无效。",
                ));
            }
            Ok(_) => std::fs::remove_file(&path).map_err(|_| {
                CommandError::new("STARTUP_CONFIG_FAILED", "无法删除开机自启配置。")
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => {
                return Err(CommandError::new(
                    "STARTUP_CONFIG_FAILED",
                    "无法读取开机自启配置。",
                ))
            }
        }
        return Ok(());
    }
    let executable = std::env::current_exe()
        .map_err(|_| CommandError::new("STARTUP_CONFIG_FAILED", "无法确定应用路径。"))?;
    let executable = executable.to_string_lossy();
    #[cfg(target_os = "macos")]
    let contents = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>com.codexkeyswitcher.tauri.preview</string><key>ProgramArguments</key><array><string>{}</string>{}</array><key>RunAtLoad</key><true/></dict></plist>\n",
        xml_escape(&executable),
        if open_as_hidden { "<string>--hidden</string>" } else { "" },
    );
    #[cfg(target_os = "linux")]
    let contents = format!(
        "[Desktop Entry]\nType=Application\nName=Codex Key Switcher Tauri Preview\nExec=\"{}\"{}\nX-GNOME-Autostart-enabled=true\n",
        executable.replace('"', "\\\""),
        if open_as_hidden { " --hidden" } else { "" },
    );
    let parent = path
        .parent()
        .ok_or_else(|| CommandError::new("STARTUP_CONFIG_FAILED", "启动项目录无效。"))?;
    std::fs::create_dir_all(parent)
        .map_err(|_| CommandError::new("STARTUP_CONFIG_FAILED", "无法创建启动项目录。"))?;
    let temporary = parent.join(format!(".cksw-startup-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| CommandError::new("STARTUP_CONFIG_FAILED", "无法写入开机自启配置。"))?;
        file.write_all(contents.as_bytes())
            .map_err(|_| CommandError::new("STARTUP_CONFIG_FAILED", "无法写入开机自启配置。"))?;
        file.sync_all()
            .map_err(|_| CommandError::new("STARTUP_CONFIG_FAILED", "无法保存开机自启配置。"))?;
        crate::storage::replace_file(&temporary, &path)
            .map_err(|_| CommandError::new("STARTUP_CONFIG_FAILED", "无法发布开机自启配置。"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[tauri::command]
pub fn app_preferences(store: State<'_, PreviewStore>) -> Result<Preferences, CommandError> {
    let settings = store.read_settings()?;
    Ok(Preferences {
        language: match settings.get("appLanguage").and_then(Value::as_str) {
            Some("en") => "en",
            _ => "zh-Hans",
        }
        .into(),
        theme: match settings.get("appTheme").and_then(Value::as_str) {
            Some("light") => "light",
            Some("dark") => "dark",
            _ => "system",
        }
        .into(),
    })
}

#[tauri::command]
pub fn app_save_preferences(
    store: State<'_, PreviewStore>,
    input: Preferences,
) -> Result<Preferences, CommandError> {
    if !matches!(input.language.as_str(), "zh-Hans" | "en")
        || !matches!(input.theme.as_str(), "system" | "light" | "dark")
    {
        return Err(CommandError::new("INVALID_PREFERENCES", "无效的界面偏好。"));
    }
    store.update_settings([
        ("appLanguage".into(), json!(input.language)),
        ("appTheme".into(), json!(input.theme)),
    ])?;
    Ok(input)
}

#[tauri::command]
pub fn app_codex_config_directory(store: State<'_, PreviewStore>) -> Result<Value, CommandError> {
    let settings = store.read_settings()?;
    let directory = settings
        .get("codexConfigDir")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("~/.codex");
    Ok(json!({ "directory": directory, "isDefault": directory == "~/.codex" }))
}

#[tauri::command]
pub fn app_save_codex_config_directory(
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
    directory: String,
) -> Result<Value, CommandError> {
    let directory = directory.trim();
    if !(directory.is_empty()
        || directory == "~/.codex"
        || directory.starts_with("~/")
        || std::path::Path::new(directory).is_absolute())
    {
        return Err(CommandError::new(
            "INVALID_CODEX_DIRECTORY",
            "Codex 配置目录必须是绝对路径或 ~/ 路径。",
        ));
    }
    let value = if directory.is_empty() {
        "~/.codex"
    } else {
        directory
    };
    let selected = codex.select_directory(&store, value)?;
    Ok(json!({ "directory": selected, "isDefault": selected == "~/.codex" }))
}

#[tauri::command]
pub fn app_prepare_codex_sandbox(
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
) -> Result<Value, CommandError> {
    let directory = codex.prepare_sandbox(&store)?;
    Ok(json!({ "directory": directory, "isDefault": false }))
}

#[tauri::command]
pub async fn app_check_for_updates() -> Value {
    tauri::async_runtime::spawn_blocking(check_for_updates_blocking)
        .await
        .unwrap_or_else(|_| {
            update_error(
                env!("CARGO_PKG_VERSION"),
                update_platform(),
                "检查更新任务失败。",
            )
        })
}

#[tauri::command]
pub async fn app_open_update_download(url: String) -> Result<(), CommandError> {
    if !allowed_release_url(&url) {
        return Err(CommandError::new(
            "INVALID_UPDATE_URL",
            "地址不属于当前项目的 GitHub Releases。",
        ));
    }
    tauri_plugin_opener::open_url(url, None::<String>)
        .map_err(|_| CommandError::new("OPEN_UPDATE_FAILED", "无法打开更新链接。"))
}

fn check_for_updates_blocking() -> Value {
    let current_version = env!("CARGO_PKG_VERSION");
    let platform = update_platform();
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => return update_error(current_version, &platform, "更新客户端初始化失败。"),
    };
    let response = match client
        .get("https://api.github.com/repos/lzwei60/codex-key-switcher/releases/latest")
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28")
        .header(
            "user-agent",
            format!("Codex-Key-Switcher/{current_version}"),
        )
        .send()
    {
        Ok(response) => response,
        Err(_) => return update_error(current_version, &platform, "检查更新失败。"),
    };
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return json!({"currentVersion":current_version,"platform":platform,"status":"not-configured","errorMessage":"没有找到最新 Release。"});
    }
    if !response.status().is_success() {
        return update_error(
            current_version,
            &platform,
            &format!("GitHub 返回 {}。", response.status().as_u16()),
        );
    }
    let payload: Value = match response.json() {
        Ok(value) => value,
        Err(_) => return update_error(current_version, &platform, "最新 Release 格式无效。"),
    };
    let tag = payload["tag_name"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_start_matches('v');
    if tag.is_empty() {
        return json!({"currentVersion":current_version,"platform":platform,"status":"not-configured","errorMessage":"最新 Release 缺少有效版本号。"});
    }
    let asset = payload["assets"].as_array().and_then(|assets| {
        assets.iter().find_map(|asset| {
            let name = asset["name"].as_str()?.to_string();
            let url = asset["browser_download_url"].as_str()?.to_string();
            if allowed_release_url(&url) && asset_matches_platform(&name, &platform) {
                Some((name, url))
            } else {
                None
            }
        })
    });
    let newer = compare_versions(tag, current_version) > 0;
    let mut result = json!({
        "currentVersion": current_version,
        "platform": platform,
        "latestVersion": tag,
        "releaseName": payload["name"].as_str().unwrap_or(tag),
        "status": if newer { "available" } else { "not-available" },
        "releaseNotesUrl": format!("https://github.com/lzwei60/codex-key-switcher/releases/tag/{}", tag),
        "publishedAt": payload["published_at"].as_str().unwrap_or(""),
    });
    if let Some((name, url)) = asset {
        result["assetName"] = json!(name);
        result["downloadUrl"] = json!(url);
    } else if newer {
        result["status"] = json!("not-configured");
        result["errorMessage"] = json!("最新版本没有匹配当前平台的安装包。");
    }
    result
}

fn update_platform() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else {
        "unsupported"
    }
}

fn allowed_release_url(url: &str) -> bool {
    url::Url::parse(url).ok().is_some_and(|parsed| {
        parsed.scheme() == "https"
            && parsed.host_str() == Some("github.com")
            && (parsed.path() == "/lzwei60/codex-key-switcher/releases"
                || parsed
                    .path()
                    .starts_with("/lzwei60/codex-key-switcher/releases/"))
    })
}

fn asset_matches_platform(name: &str, platform: &str) -> bool {
    let name = name.to_lowercase();
    if !name.contains("codex-key-switcher") && !name.contains("codex key switcher") {
        return false;
    }
    match platform {
        "darwin-arm64" => {
            name.ends_with(".dmg") && (name.contains("arm64") || name.contains("aarch64"))
        }
        "darwin-x64" => {
            name.ends_with(".dmg")
                && (name.contains("x64") || name.contains("intel") || name.contains("x86_64"))
        }
        "win32-x64" => name.ends_with(".exe") && (name.contains("x64") || name.contains("x86_64")),
        "linux-x64" => {
            (name.ends_with(".appimage") || name.ends_with(".deb"))
                && (name.contains("x64") || name.contains("amd64") || name.contains("x86_64"))
        }
        _ => false,
    }
}

fn compare_versions(left: &str, right: &str) -> i32 {
    let left = left
        .split(['+', '-'])
        .map(|part| part.parse::<i32>().unwrap_or(0))
        .collect::<Vec<_>>();
    let right = right
        .trim_start_matches('v')
        .split(['+', '-'])
        .map(|part| part.parse::<i32>().unwrap_or(0))
        .collect::<Vec<_>>();
    (0..left.len().max(right.len()))
        .map(|index| left.get(index).copied().unwrap_or(0) - right.get(index).copied().unwrap_or(0))
        .find(|value| *value != 0)
        .unwrap_or(0)
}

fn update_error(version: &str, platform: &str, message: &str) -> Value {
    json!({"currentVersion":version,"platform":platform,"status":"error","errorMessage":message})
}

#[tauri::command]
pub fn providers_list(store: State<'_, PreviewStore>) -> Result<Value, CommandError> {
    store.list_providers()
}

#[tauri::command]
pub fn providers_export_metadata(store: State<'_, PreviewStore>) -> Result<Value, CommandError> {
    crate::providers::export_provider_metadata(&store)
}

#[tauri::command]
pub fn providers_export_metadata_file(
    store: State<'_, PreviewStore>,
    path: String,
) -> Result<Value, CommandError> {
    let path = std::path::PathBuf::from(path.trim());
    if path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err(CommandError::new(
            "INVALID_EXPORT_PATH",
            "导出文件路径无效。",
        ));
    }
    if path.exists() {
        return Err(CommandError::new(
            "EXPORT_FILE_EXISTS",
            "导出文件已存在，不会覆盖。",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| CommandError::new("INVALID_EXPORT_PATH", "导出文件目录无效。"))?;
    if !parent.is_dir() {
        return Err(CommandError::new(
            "INVALID_EXPORT_PATH",
            "导出文件目录不存在。",
        ));
    }
    let payload = crate::providers::export_provider_metadata(&store)?;
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&payload).map_err(|_| {
            CommandError::new("PROVIDER_EXPORT_FAILED", "供应商配置无法导出。")
        })?
    );
    if text.len() > 8 * 1024 * 1024 {
        return Err(CommandError::new(
            "PROVIDER_EXPORT_FAILED",
            "供应商配置文件过大。",
        ));
    }
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| CommandError::new("PROVIDER_EXPORT_FAILED", "供应商配置文件无法写入。"))?;
    file.write_all(text.as_bytes())
        .map_err(|_| CommandError::new("PROVIDER_EXPORT_FAILED", "供应商配置文件无法写入。"))?;
    file.sync_all()
        .map_err(|_| CommandError::new("PROVIDER_EXPORT_FAILED", "供应商配置文件无法保存。"))?;
    Ok(
        json!({ "path": path, "providerCount": payload["providers"].as_array().map(Vec::len).unwrap_or(0) }),
    )
}

#[tauri::command]
pub fn providers_import_metadata_file(
    store: State<'_, PreviewStore>,
    keyring: State<'_, SystemKeyring>,
    path: String,
) -> Result<Value, CommandError> {
    let path = std::path::PathBuf::from(path.trim());
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| CommandError::new("INVALID_IMPORT_PATH", "导入文件不存在或无法读取。"))?;
    if !metadata.file_type().is_file() || metadata.len() > 8 * 1024 * 1024 {
        return Err(CommandError::new(
            "INVALID_IMPORT_FILE",
            "导入文件无效或超过大小限制。",
        ));
    }
    let payload: Value = serde_json::from_slice(
        &std::fs::read(&path)
            .map_err(|_| CommandError::new("INVALID_IMPORT_FILE", "导入文件无法读取。"))?,
    )
    .map_err(|_| CommandError::new("INVALID_PROVIDER_EXPORT", "供应商配置文件格式无效。"))?;
    let imported = crate::providers::import_provider_metadata(
        &store,
        &*keyring,
        crate::providers::ProviderConfigImportInput {
            payload,
            credentials: None,
        },
    )?;
    Ok(json!({ "importedCount": imported }))
}

#[tauri::command]
pub fn providers_import_metadata(
    store: State<'_, PreviewStore>,
    keyring: State<'_, SystemKeyring>,
    input: crate::providers::ProviderConfigImportInput,
) -> Result<Value, CommandError> {
    let imported = crate::providers::import_provider_metadata(&store, &*keyring, input)?;
    Ok(json!({ "importedCount": imported }))
}

#[tauri::command]
pub fn providers_save(
    store: State<'_, PreviewStore>,
    keyring: State<'_, SystemKeyring>,
    state: State<'_, GatewayState>,
    codex: State<'_, CodexState>,
    input: ProviderInput,
) -> Result<Value, CommandError> {
    let provider_id = input.id().map(str::to_string);
    let previous_document = store.provider_document()?;
    let previous_credential = provider_id
        .as_deref()
        .map(|id| keyring.get(id))
        .transpose()?
        .flatten();
    let result = crate::providers::save_provider(&store, &*keyring, input)?;
    if let Err(error) = sync_running_gateway(&state, &store, &codex) {
        restore_provider_mutation(
            &store,
            &*keyring,
            provider_id.as_deref().or_else(|| result["id"].as_str()),
            previous_document,
            previous_credential,
        )?;
        return Err(error);
    }
    Ok(result)
}

#[tauri::command]
pub fn providers_delete(
    store: State<'_, PreviewStore>,
    keyring: State<'_, SystemKeyring>,
    state: State<'_, GatewayState>,
    codex: State<'_, CodexState>,
    id: String,
) -> Result<(), CommandError> {
    let previous_document = store.provider_document()?;
    let previous_credential = keyring.get(id.trim())?;
    let running = gateway_is_running(&state, &store)?;
    if running
        && store
            .list_providers()?
            .as_array()
            .is_some_and(|providers| providers.len() <= 1)
    {
        return Err(CommandError::new(
            "PROVIDER_IN_USE",
            "运行中的本地网关至少需要一个供应商。",
        ));
    }
    crate::providers::delete_provider(&store, &*keyring, &id)?;
    if let Err(error) = sync_running_gateway(&state, &store, &codex) {
        restore_provider_mutation(
            &store,
            &*keyring,
            Some(id.trim()),
            previous_document,
            previous_credential,
        )?;
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn providers_set_current(
    store: State<'_, PreviewStore>,
    keyring: State<'_, SystemKeyring>,
    state: State<'_, GatewayState>,
    codex: State<'_, CodexState>,
    id: String,
) -> Result<(), CommandError> {
    let previous_document = store.provider_document()?;
    crate::providers::set_current_provider(&store, &*keyring, &id)?;
    if let Err(error) = sync_running_gateway(&state, &store, &codex) {
        restore_provider_mutation(&store, &*keyring, None, previous_document, None)?;
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn providers_set_selected_model(
    store: State<'_, PreviewStore>,
    state: State<'_, GatewayState>,
    codex: State<'_, CodexState>,
    provider_id: String,
    model: String,
) -> Result<(), CommandError> {
    let previous_document = store.provider_document()?;
    crate::providers::set_selected_model(&store, &provider_id, &model)?;
    if let Err(error) = sync_running_gateway(&state, &store, &codex) {
        restore_provider_mutation(&store, &SystemKeyring, None, previous_document, None)?;
        return Err(error);
    }
    Ok(())
}

fn gateway_is_running(state: &GatewayState, store: &PreviewStore) -> Result<bool, CommandError> {
    Ok(state.status(store)?["running"].as_bool().unwrap_or(false))
}

fn sync_running_gateway(
    state: &GatewayState,
    store: &PreviewStore,
    codex: &CodexState,
) -> Result<(), CommandError> {
    let settings = normalize_gateway_settings(&store.read_settings()?);
    if !settings["enabled"].as_bool().unwrap_or(false) {
        return Ok(());
    }
    if settings["mode"] == "direct_provider" {
        return codex.sync_direct_provider(store, &SystemKeyring);
    }
    if !gateway_is_running(state, store)? {
        return Ok(());
    }
    let status = state.status(store)?;
    let endpoint = status["endpoint"].as_str().unwrap_or("");
    let token = store.local_gateway_api_key()?;
    codex.sync_gateway(store, endpoint, &token)
}

fn restore_provider_mutation(
    store: &PreviewStore,
    keyring: &SystemKeyring,
    provider_id: Option<&str>,
    previous_document: Value,
    previous_credential: Option<String>,
) -> Result<(), CommandError> {
    store.replace_provider_document(&previous_document)?;
    if let Some(id) = provider_id {
        match previous_credential {
            Some(value) => keyring.set(id, &value)?,
            None => keyring.delete(id)?,
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn providers_validate_model(
    keyring: State<'_, SystemKeyring>,
    input: ProviderModelValidationInput,
) -> Result<Value, CommandError> {
    let started = Instant::now();
    let model = input.model.model.trim().to_string();
    let format = input.api_format.trim().to_string();
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    let endpoint = validation_endpoint(&base_url, &format).unwrap_or_else(|| base_url.clone());
    if model.is_empty() {
        return Ok(validation_failure(
            &endpoint,
            &model,
            started,
            "上游模型不能为空。",
        ));
    }
    if !matches!(
        format.as_str(),
        "responses" | "chat_completions" | "anthropic_messages"
    ) {
        return Ok(validation_failure(
            &endpoint,
            &model,
            started,
            "API 格式不受支持。",
        ));
    }
    let api_key = match input.api_key.filter(|value| !value.trim().is_empty()) {
        Some(value) => value,
        None => match input.provider_id.filter(|value| !value.trim().is_empty()) {
            Some(id) => keyring.get(&id)?.ok_or_else(|| {
                CommandError::new(
                    "MISSING_CREDENTIAL",
                    "请先填写 API Key，或保存该供应商的 Key。",
                )
            })?,
            None => {
                return Ok(validation_failure(
                    &endpoint,
                    &model,
                    started,
                    "请先填写 API Key。",
                ))
            }
        },
    };
    let url = match url::Url::parse(&endpoint) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => url,
        _ => {
            return Ok(validation_failure(
                &endpoint,
                &model,
                started,
                "Base URL 不是有效地址。",
            ))
        }
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| CommandError::new("MODEL_VALIDATION_FAILED", "模型检测请求初始化失败。"))?;
    let request_body = match format.as_str() {
        "chat_completions" => json!({
            "model": model,
            "messages": [{"role":"user","content":"ping"}],
            "max_tokens": 16,
            "stream": false,
        }),
        "anthropic_messages" => json!({
            "model": model,
            "messages": [{"role":"user","content":"ping"}],
            "max_tokens": 16,
            "stream": false,
        }),
        _ => json!({"model": model, "input":"ping", "max_output_tokens":16, "stream":false}),
    };
    let mut request = client
        .post(url)
        .header("content-type", "application/json")
        .body(request_body.to_string());
    request = if format == "anthropic_messages" {
        request
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(&api_key)
    };
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            let message = if error.is_timeout() {
                "检测超时，上游 20 秒内未响应。"
            } else {
                "模型检测请求失败。"
            };
            return Ok(validation_failure(&endpoint, &model, started, message));
        }
    };
    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let body = response.text().await.unwrap_or_default();
    let preview = body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect::<String>();
    Ok(json!({
        "ok": ok,
        "status": status,
        "durationMs": started.elapsed().as_millis(),
        "endpoint": endpoint,
        "model": model,
        "message": if ok { format!("模型 {} 连通性检测通过。", model) } else { format!("上游返回 {}：{}", status, if preview.is_empty() { "请求失败" } else { &preview }) },
        "responsePreview": preview,
    }))
}

#[tauri::command]
pub async fn providers_list_upstream_models(
    keyring: State<'_, SystemKeyring>,
    input: ProviderModelsListInput,
) -> Result<Value, CommandError> {
    let started = Instant::now();
    let format = input.api_format.trim().to_string();
    let base_url = input.base_url.trim().trim_end_matches('/').to_string();
    let endpoint = models_endpoint(&base_url);
    let api_key = match input.api_key.filter(|value| !value.trim().is_empty()) {
        Some(value) => value,
        None => match input.provider_id.filter(|value| !value.trim().is_empty()) {
            Some(id) => keyring.get(&id)?.ok_or_else(|| {
                CommandError::new(
                    "MISSING_CREDENTIAL",
                    "请先填写 API Key，或保存该供应商的 Key。",
                )
            })?,
            None => {
                return Ok(models_list_failure(
                    &endpoint,
                    started,
                    "请先填写 API Key。",
                ))
            }
        },
    };
    if !matches!(
        format.as_str(),
        "responses" | "chat_completions" | "anthropic_messages"
    ) {
        return Ok(models_list_failure(
            &endpoint,
            started,
            "API 格式不受支持。",
        ));
    }
    let url = match url::Url::parse(&endpoint) {
        Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => url,
        _ => {
            return Ok(models_list_failure(
                &endpoint,
                started,
                "Base URL 不是有效地址。",
            ))
        }
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| CommandError::new("MODEL_LIST_FAILED", "模型列表请求初始化失败。"))?;
    let mut request = client.get(url);
    request = if format == "anthropic_messages" {
        request
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(&api_key)
    };
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return Ok(models_list_failure(
                &endpoint,
                started,
                if error.is_timeout() {
                    "拉取超时，上游 20 秒内未响应。"
                } else {
                    "拉取上游模型列表失败。"
                },
            ))
        }
    };
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > 8 * 1024 * 1024)
    {
        return Ok(models_list_failure(
            &endpoint,
            started,
            "上游模型列表响应过大。",
        ));
    }
    let body = response.bytes().await.unwrap_or_default();
    let preview = compact_preview(&body);
    if status < 200 || status >= 300 {
        return Ok(json!({
            "ok": false,
            "status": status,
            "durationMs": started.elapsed().as_millis(),
            "endpoint": endpoint,
            "models": [],
            "message": format!("上游返回 {}：{}", status, if preview.is_empty() { "请求失败" } else { &preview }),
            "responsePreview": preview,
        }));
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return Ok(models_list_failure(
                &endpoint,
                started,
                "上游返回的模型列表不是合法 JSON。",
            ))
        }
    };
    let mut ids = Vec::new();
    collect_model_ids(&payload, &mut ids);
    ids.sort();
    ids.dedup();
    let models = ids
        .iter()
        .map(|id| json!({ "customName": id, "model": id }))
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Ok(json!({
            "ok": false,
            "status": status,
            "durationMs": started.elapsed().as_millis(),
            "endpoint": endpoint,
            "models": [],
            "message": "上游没有返回可识别的模型列表。",
            "responsePreview": preview,
        }));
    }
    Ok(json!({
        "ok": true,
        "status": status,
        "durationMs": started.elapsed().as_millis(),
        "endpoint": endpoint,
        "models": models,
        "message": format!("已拉取 {} 个上游模型。", ids.len()),
        "responsePreview": preview,
    }))
}

fn models_endpoint(base_url: &str) -> String {
    match url::Url::parse(base_url) {
        Ok(mut url) => {
            let path = url.path().trim_end_matches('/');
            let prefix = if path.is_empty() { "/v1" } else { path };
            url.set_path(&format!("{prefix}/models"));
            url.to_string()
        }
        Err(_) => format!("{base_url}/models"),
    }
}

fn collect_model_ids(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::Array(values) => values
            .iter()
            .for_each(|value| collect_model_ids(value, output)),
        Value::Object(object) => {
            for key in ["id", "name", "model"] {
                if let Some(value) = object.get(key).and_then(Value::as_str) {
                    if !value.trim().is_empty() {
                        output.push(value.trim().to_string());
                    }
                }
            }
            for key in ["data", "models"] {
                if let Some(value) = object.get(key) {
                    collect_model_ids(value, output);
                }
            }
        }
        _ => {}
    }
}

fn compact_preview(body: &[u8]) -> String {
    String::from_utf8_lossy(body)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect()
}

fn models_list_failure(endpoint: &str, started: Instant, message: &str) -> Value {
    json!({
        "ok": false,
        "durationMs": started.elapsed().as_millis(),
        "endpoint": endpoint,
        "models": [],
        "message": message,
    })
}

fn validation_endpoint(base_url: &str, format: &str) -> Option<String> {
    let mut url = url::Url::parse(base_url).ok()?;
    let path = url.path().trim_end_matches('/');
    let prefix = if path.is_empty() { "/v1" } else { path };
    let suffix = match format {
        "chat_completions" => "/chat/completions",
        "anthropic_messages" => "/messages",
        "responses" => "/responses",
        _ => return None,
    };
    url.set_path(&format!("{prefix}{suffix}"));
    Some(url.to_string())
}

fn validation_failure(endpoint: &str, model: &str, started: Instant, message: &str) -> Value {
    json!({
        "ok": false,
        "durationMs": started.elapsed().as_millis(),
        "endpoint": endpoint,
        "model": model,
        "message": message,
    })
}

#[tauri::command]
pub async fn app_import_credential_migration(
    store: State<'_, PreviewStore>,
    keyring: State<'_, SystemKeyring>,
    input: crate::migration_crypto::EncryptedMigrationPackage,
    passphrase: String,
) -> Result<Value, CommandError> {
    let input = tauri::async_runtime::spawn_blocking(move || {
        crate::migration_crypto::decrypt(input, &passphrase)
    })
    .await
    .map_err(|_| CommandError::new("MIGRATION_DECRYPT_FAILED", "迁移解密失败。"))??;
    crate::providers::import_credential_migration(&store, &*keyring, input)
}

#[tauri::command]
pub async fn app_export_credential_migration(
    store: State<'_, PreviewStore>,
    keyring: State<'_, SystemKeyring>,
    path: String,
    passphrase: String,
) -> Result<Value, CommandError> {
    let path = validate_new_export_path(&path)?;
    let payload = crate::providers::credential_migration_payload(&store, &*keyring)?;
    let provider_count = payload.providers.len();
    let credential_count = payload.credentials.len();
    let encrypted = tauri::async_runtime::spawn_blocking(move || {
        crate::migration_crypto::encrypt(&payload, &passphrase)
    })
    .await
    .map_err(|_| CommandError::new("MIGRATION_ENCRYPT_FAILED", "迁移包加密失败。"))??;
    let text = format!(
        "{}\n",
        serde_json::to_string(&encrypted)
            .map_err(|_| CommandError::new("MIGRATION_EXPORT_FAILED", "迁移包无法生成。"))?
    );
    write_exclusive_private(
        &path,
        text.as_bytes(),
        "MIGRATION_EXPORT_FAILED",
        "迁移包无法写入。",
    )?;
    Ok(json!({
        "providerCount": provider_count,
        "credentialCount": credential_count,
        "missingCredentialCount": 0,
    }))
}

fn validate_new_export_path(path: &str) -> Result<std::path::PathBuf, CommandError> {
    let path = std::path::PathBuf::from(path.trim());
    if path.as_os_str().is_empty() || path.file_name().is_none() || path.exists() {
        return Err(CommandError::new(
            "EXPORT_FILE_EXISTS",
            "导出文件路径无效或已存在。",
        ));
    }
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| CommandError::new("INVALID_EXPORT_PATH", "导出文件目录无效。"))?;
    if std::fs::symlink_metadata(parent)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(true)
    {
        return Err(CommandError::new(
            "INVALID_EXPORT_PATH",
            "导出文件目录无效。",
        ));
    }
    Ok(path)
}

fn write_exclusive_private(
    path: &std::path::Path,
    bytes: &[u8],
    code: &'static str,
    message: &'static str,
) -> Result<(), CommandError> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| CommandError::new(code, message))?;
    file.write_all(bytes)
        .map_err(|_| CommandError::new(code, message))?;
    file.sync_all()
        .map_err(|_| CommandError::new(code, message))
}

#[tauri::command]
pub fn gateway_status(
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
) -> Result<Value, CommandError> {
    let settings = normalize_gateway_settings(&store.read_settings()?);
    if settings["mode"] == "direct_provider" {
        return direct_status(&store);
    }
    state.status(&store)
}

#[tauri::command]
pub fn gateway_start(
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
) -> Result<Value, CommandError> {
    let previous = normalize_gateway_settings(&store.read_settings()?);
    let mut enabled = previous.clone();
    enabled["enabled"] = json!(true);
    enabled["disabledExplicitly"] = json!(false);
    store.update_settings([("routeSettings".into(), enabled)])?;

    let result = start_enabled_connection_and_sync(&state, &store, &codex);
    if result.is_err() {
        let _ = store.update_settings([("routeSettings".into(), previous.clone())]);
        let _ = restore_enabled_connection(&previous, &state, &store, &codex);
    }
    result
}

#[tauri::command]
pub fn gateway_stop(
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
) -> Result<Value, CommandError> {
    let previous = normalize_gateway_settings(&store.read_settings()?);
    let mut disabled = previous.clone();
    disabled["enabled"] = json!(false);
    disabled["disabledExplicitly"] = json!(true);
    store.update_settings([("routeSettings".into(), disabled)])?;

    let result = stop_gateway_runtime_and_restore(&state, &store, &codex);
    if result.is_err() {
        let _ = store.update_settings([("routeSettings".into(), previous.clone())]);
    }
    result
}

#[tauri::command]
pub fn gateway_settings(store: State<'_, PreviewStore>) -> Result<Value, CommandError> {
    Ok(normalize_gateway_settings(&store.read_settings()?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySettingsInput {
    mode: String,
    enabled: bool,
    auto_start: bool,
    disabled_explicitly: bool,
    listen_address: String,
    listen_port: u32,
    allow_lan_listen: bool,
    failover_enabled: bool,
    failover_max_attempts: u32,
    failover_total_timeout_ms: u32,
    failover_failure_threshold: u32,
    failover_cooldown_ms: u32,
    failover_half_open_max_requests: u32,
}

#[tauri::command]
pub fn gateway_save_settings(
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
    input: GatewaySettingsInput,
) -> Result<Value, CommandError> {
    if !matches!(input.mode.as_str(), "local_gateway" | "direct_provider")
        || input.listen_address != "127.0.0.1"
        || input.allow_lan_listen
        || !(1024..=65_535).contains(&input.listen_port)
        || !(1..=20).contains(&input.failover_max_attempts)
        || !(1_000..=1_800_000).contains(&input.failover_total_timeout_ms)
        || !(1..=100).contains(&input.failover_failure_threshold)
        || !(1_000..=3_600_000).contains(&input.failover_cooldown_ms)
        || !(1..=20).contains(&input.failover_half_open_max_requests)
    {
        return Err(CommandError::new(
            "INVALID_GATEWAY_SETTINGS",
            "Tauri 预览网关设置超出允许范围。",
        ));
    }
    let previous = normalize_gateway_settings(&store.read_settings()?);
    let settings = json!({
        "mode": input.mode,
        "enabled": input.enabled,
        "autoStart": input.auto_start,
        "disabledExplicitly": input.disabled_explicitly,
        "listenAddress": "127.0.0.1",
        "listenPort": input.listen_port,
        "allowLANListen": false,
        "failoverEnabled": input.failover_enabled,
        "failoverMaxAttempts": input.failover_max_attempts,
        "failoverTotalTimeoutMs": input.failover_total_timeout_ms,
        "failoverFailureThreshold": input.failover_failure_threshold,
        "failoverCooldownMs": input.failover_cooldown_ms,
        "failoverHalfOpenMaxRequests": input.failover_half_open_max_requests,
    });
    let port_changed = previous["listenPort"] != settings["listenPort"];
    let was_running = gateway_is_running(&state, &store)?;
    store.update_settings([("routeSettings".into(), settings.clone())])?;
    let result = if input.enabled {
        if port_changed && was_running {
            stop_gateway_runtime_and_restore(&state, &store, &codex)?;
        }
        start_enabled_connection_and_sync(&state, &store, &codex)
    } else {
        stop_gateway_runtime_and_restore(&state, &store, &codex)
    };
    if let Err(error) = result {
        let _ = store.update_settings([("routeSettings".into(), previous.clone())]);
        let _ = restore_enabled_connection(&previous, &state, &store, &codex);
        return Err(error);
    }
    Ok(json!({
        "settings": settings,
        "changed": settings != previous,
        "cancelled": false,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPortCheckInput {
    listen_address: String,
    listen_port: u32,
    allow_lan_listen: bool,
}

#[tauri::command]
pub fn gateway_check_port(
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
    input: GatewayPortCheckInput,
) -> Result<Value, CommandError> {
    if input.listen_address != "127.0.0.1"
        || input.allow_lan_listen
        || !(1024..=65_535).contains(&input.listen_port)
    {
        return Err(CommandError::new(
            "INVALID_GATEWAY_PORT",
            "Tauri 预览网关只允许检测 127.0.0.1 的 1024-65535 端口。",
        ));
    }
    let requested = input.listen_port as u16;
    let running = state.status(&store)?;
    let owns_requested_port = running["running"].as_bool().unwrap_or(false)
        && running["endpoint"]
            .as_str()
            .and_then(|endpoint| url::Url::parse(endpoint).ok())
            .and_then(|endpoint| endpoint.port())
            == Some(requested);
    if owns_requested_port {
        return Ok(json!({
            "available": true,
            "listenAddress": "127.0.0.1",
            "listenPort": requested,
            "message": format!("端口 {requested} 可用。"),
        }));
    }
    match TcpListener::bind(("127.0.0.1", requested)) {
        Ok(listener) => {
            drop(listener);
            Ok(json!({
                "available": true,
                "listenAddress": "127.0.0.1",
                "listenPort": requested,
                "message": format!("端口 {requested} 可用。"),
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Ok(json!({
            "available": false,
            "listenAddress": "127.0.0.1",
            "listenPort": requested,
            "message": format!("端口 {requested} 已被占用。"),
        })),
        Err(_) => Err(CommandError::new(
            "GATEWAY_PORT_CHECK_FAILED",
            "无法检测本地网关端口。",
        )),
    }
}

fn sync_gateway_codex(
    state: &GatewayState,
    store: &PreviewStore,
    codex: &CodexState,
) -> Result<(), CommandError> {
    let status = state.status(store)?;
    if !status["running"].as_bool().unwrap_or(false) {
        return Err(CommandError::new(
            "GATEWAY_NOT_RUNNING",
            "本地网关未运行，无法同步 Codex 配置。",
        ));
    }
    let endpoint = status["endpoint"].as_str().unwrap_or("");
    let token = store.local_gateway_api_key()?;
    codex.sync_gateway(store, endpoint, &token)
}

fn direct_status(store: &PreviewStore) -> Result<Value, CommandError> {
    let current_id = store.current_provider_id()?;
    let providers = store.list_providers()?;
    let provider = providers.as_array().and_then(|items| {
        current_id
            .as_deref()
            .and_then(|id| items.iter().find(|item| item["id"] == id))
    });
    let Some(provider) = provider else {
        return Ok(json!({
            "running": false,
            "mode": "direct_provider",
            "endpoint": "未选择供应商"
        }));
    };
    let provider_id = provider["id"].as_str().unwrap_or("");
    let display_model = provider["selectedModel"].as_str().unwrap_or("");
    let model_name = provider["models"]
        .as_array()
        .and_then(|models| {
            models.iter().find(|model| {
                model["customName"] == display_model || model["model"] == display_model
            })
        })
        .and_then(|model| model["model"].as_str())
        .unwrap_or(display_model);
    let base_url = provider["baseURL"].as_str().unwrap_or("未选择供应商");
    Ok(json!({
        "running": false,
        "mode": "direct_provider",
        "endpoint": base_url,
        "currentProviderId": provider_id,
        "currentProviderName": provider["name"].as_str().unwrap_or(""),
        "currentModel": display_model,
        "directSessionTarget": {
            "id": format!("{provider_id}:{model_name}"),
            "providerId": provider_id,
            "providerName": provider["name"].as_str().unwrap_or(""),
            "baseURL": base_url,
            "modelName": model_name,
            "displayModel": display_model,
            "appliedAt": 0,
        }
    }))
}

pub(crate) fn start_enabled_connection_and_sync(
    state: &GatewayState,
    store: &PreviewStore,
    codex: &CodexState,
) -> Result<Value, CommandError> {
    let settings = normalize_gateway_settings(&store.read_settings()?);
    if settings["mode"] == "direct_provider" {
        if gateway_is_running(state, store)? {
            state.stop(store)?;
            codex.restore(store)?;
        }
        codex.sync_direct_provider(store, &SystemKeyring)?;
        return direct_status(store);
    }
    start_gateway_runtime_and_sync(state, store, codex)
}

fn restore_enabled_connection(
    settings: &Value,
    state: &GatewayState,
    store: &PreviewStore,
    codex: &CodexState,
) -> Result<(), CommandError> {
    if !settings["enabled"].as_bool().unwrap_or(false) {
        return Ok(());
    }
    store.update_settings([("routeSettings".into(), settings.clone())])?;
    start_enabled_connection_and_sync(state, store, codex).map(|_| ())
}

pub(crate) fn start_gateway_runtime_and_sync(
    state: &GatewayState,
    store: &PreviewStore,
    codex: &CodexState,
) -> Result<Value, CommandError> {
    let was_running = state.status(store)?["running"].as_bool().unwrap_or(false);
    state.start(store)?;
    if let Err(error) = sync_gateway_codex(state, store, codex) {
        if !was_running {
            let _ = state.stop(store);
        }
        return Err(error);
    }
    state.status(store)
}

pub(crate) fn stop_gateway_runtime_and_restore(
    state: &GatewayState,
    store: &PreviewStore,
    codex: &CodexState,
) -> Result<Value, CommandError> {
    let was_running = state.status(store)?["running"].as_bool().unwrap_or(false);
    let status = state.stop(store)?;
    if let Err(error) = codex.restore(store) {
        // Keep Codex usable when restoring its files fails: restart the gateway
        // and point the sandbox back at the new endpoint before returning error.
        if was_running {
            let _ = start_gateway_runtime_and_sync(state, store, codex);
        }
        return Err(error);
    }
    Ok(status)
}

fn normalize_gateway_settings(settings: &serde_json::Map<String, Value>) -> Value {
    let stored = settings.get("routeSettings").and_then(Value::as_object);
    let number = |key: &str, minimum: u64, maximum: u64, fallback: u64| {
        stored
            .and_then(|value| value.get(key))
            .and_then(Value::as_u64)
            .map(|value| value.clamp(minimum, maximum))
            .unwrap_or(fallback)
    };
    json!({
        "mode": stored
            .and_then(|value| value.get("mode"))
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "local_gateway" | "direct_provider"))
            .unwrap_or("local_gateway"),
        "enabled": stored.and_then(|value| value.get("enabled")).and_then(Value::as_bool).unwrap_or(false),
        "autoStart": stored.and_then(|value| value.get("autoStart")).and_then(Value::as_bool).unwrap_or(false),
        "disabledExplicitly": stored.and_then(|value| value.get("disabledExplicitly")).and_then(Value::as_bool).unwrap_or(true),
        "listenAddress": "127.0.0.1",
        "listenPort": number("listenPort", 1024, 65_535, 3456),
        "allowLANListen": false,
        "failoverEnabled": stored.and_then(|value| value.get("failoverEnabled")).and_then(Value::as_bool).unwrap_or(false),
        "failoverMaxAttempts": number("failoverMaxAttempts", 1, 20, 3),
        "failoverTotalTimeoutMs": number("failoverTotalTimeoutMs", 1_000, 1_800_000, 180_000),
        "failoverFailureThreshold": number("failoverFailureThreshold", 1, 100, 3),
        "failoverCooldownMs": number("failoverCooldownMs", 1_000, 3_600_000, 60_000),
        "failoverHalfOpenMaxRequests": number("failoverHalfOpenMaxRequests", 1, 20, 1),
    })
}

#[tauri::command]
pub fn diagnostics_read(
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
) -> Result<Value, CommandError> {
    let settings = normalize_gateway_settings(&store.read_settings()?);
    let gateway = if settings["mode"] == "direct_provider" {
        direct_status(&store)?
    } else {
        state.status(&store)?
    };
    let directory = codex.configured_directory(&store)?;
    let restore_available = codex.restore_available(&store)?;
    let gateway_endpoint = gateway["endpoint"].as_str().unwrap_or("");
    let sandbox_synced = if gateway["running"].as_bool().unwrap_or(false) {
        codex.uses_endpoint(&store, gateway_endpoint)?
    } else {
        false
    };
    Ok(json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "connectionMode": settings["mode"].as_str().unwrap_or("local_gateway"),
        "routeEnabled": settings["enabled"].as_bool().unwrap_or(false),
        "codexUsesGateway": sandbox_synced,
        "gatewayRunning": gateway["running"],
        "codexDirectory": directory,
        "endpoint": gateway["endpoint"].as_str().unwrap_or("未接入本地路由"),
        "issues": ["Tauri 使用隔离 Preview 数据目录和本机回环网关；不会修改真实 ~/.codex。"],
        "restoreAvailable": restore_available,
        "restoreScriptPath": store.preview_data_directory().to_string_lossy(),
        "healthStatus": if settings["mode"] == "direct_provider" && settings["enabled"].as_bool().unwrap_or(false) {
            "正常 · 直连供应商"
        } else if gateway["running"].as_bool().unwrap_or(false) {
            "正常 · 运行正常"
        } else {
            "警告 · 代理未运行"
        },
    }))
}

#[tauri::command]
pub fn diagnostics_copy_report(
    app: AppHandle,
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
) -> Result<(), CommandError> {
    let report = diagnostics_read(state, store, codex)?;
    let text = serde_json::to_string_pretty(&report)
        .map_err(|_| CommandError::new("COPY_REPORT_FAILED", "诊断信息无法生成。"))?;
    tauri_plugin_clipboard_manager::ClipboardExt::clipboard(&app)
        .write_text(text)
        .map_err(|_| CommandError::new("COPY_REPORT_FAILED", "诊断信息无法复制。"))
}

#[tauri::command]
pub fn diagnostics_resync_codex_config(
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
) -> Result<Value, CommandError> {
    let settings = normalize_gateway_settings(&store.read_settings()?);
    if !settings["enabled"].as_bool().unwrap_or(false) {
        return Err(CommandError::new(
            "CONNECTION_NOT_ENABLED",
            "请先启用一种连接模式，再同步 Codex 配置。",
        ));
    }
    if settings["mode"] == "direct_provider" {
        codex.sync_direct_provider(&store, &SystemKeyring)?;
    } else {
        let gateway = state.status(&store)?;
        if !gateway["running"].as_bool().unwrap_or(false) {
            return Err(CommandError::new(
                "GATEWAY_NOT_RUNNING",
                "请先启动隔离本地网关，再同步 Codex 配置。",
            ));
        }
        let endpoint = gateway["endpoint"].as_str().unwrap_or("");
        let local_gateway_api_key = store.local_gateway_api_key()?;
        codex.sync_gateway(&store, endpoint, &local_gateway_api_key)?;
    }
    diagnostics_read(state, store, codex)
}

#[tauri::command]
pub fn diagnostics_stop_and_restore_codex(
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
) -> Result<Value, CommandError> {
    stop_gateway_runtime_and_restore(&state, &store, &codex)?;
    diagnostics_read(state, store, codex)
}

#[tauri::command]
pub fn diagnostics_prepare_uninstall(
    state: State<'_, GatewayState>,
    store: State<'_, PreviewStore>,
    codex: State<'_, CodexState>,
) -> Result<Value, CommandError> {
    stop_gateway_runtime_and_restore(&state, &store, &codex)?;
    let mut settings = normalize_gateway_settings(&store.read_settings()?);
    settings["enabled"] = json!(false);
    settings["autoStart"] = json!(false);
    settings["disabledExplicitly"] = json!(true);
    store.update_settings([("routeSettings".into(), settings)])?;
    diagnostics_read(state, store, codex)
}

#[tauri::command]
pub fn diagnostics_open_restore_directory(
    store: State<'_, PreviewStore>,
) -> Result<(), CommandError> {
    tauri_plugin_opener::open_path(store.preview_data_directory(), None::<String>)
        .map_err(|_| CommandError::new("OPEN_RESTORE_DIRECTORY_FAILED", "无法打开隔离恢复目录。"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatsInput {
    pub(crate) log_page: u32,
    pub(crate) log_page_size: u32,
}

#[tauri::command]
pub async fn usage_stats(
    store: State<'_, PreviewStore>,
    input: UsageStatsInput,
) -> Result<Value, CommandError> {
    let path = store.usage_database_path();
    tauri::async_runtime::spawn_blocking(move || crate::usage::read_stats(&path, input))
        .await
        .map_err(|_| CommandError::new("USAGE_READ_FAILED", "读取用量统计失败。"))?
}

#[tauri::command]
pub async fn usage_clear_logs(store: State<'_, PreviewStore>) -> Result<Value, CommandError> {
    let path = store.usage_database_path();
    tauri::async_runtime::spawn_blocking(move || crate::usage::clear_logs(&path))
        .await
        .map_err(|_| CommandError::new("USAGE_CLEAR_FAILED", "清除用量日志失败。"))?
}

#[tauri::command]
pub fn usage_settings(store: State<'_, PreviewStore>) -> Result<Value, CommandError> {
    let settings = store.read_settings()?;
    match settings.get("usageSettings").and_then(Value::as_str) {
        Some(raw) => Ok(normalize_usage_settings(
            serde_json::from_str(raw).unwrap_or(Value::Null),
        )),
        None => Ok(default_usage_settings()),
    }
}

fn default_usage_settings() -> Value {
    json!({ "enabled": false, "retentionDays": 30, "maxRecords": 10000 })
}

fn normalize_usage_settings(value: Value) -> Value {
    let valid_number = |key: &str, minimum: u64, maximum: u64, fallback: u64| {
        value
            .get(key)
            .and_then(Value::as_u64)
            .map(|number| number.clamp(minimum, maximum))
            .unwrap_or(fallback)
    };
    json!({
        "enabled": value.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "retentionDays": valid_number("retentionDays", 1, 365, 30),
        "maxRecords": valid_number("maxRecords", 100, 100_000, 10_000),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSettingsInput {
    enabled: bool,
    retention_days: u32,
    max_records: u32,
}

#[tauri::command]
pub fn usage_save_settings(
    store: State<'_, PreviewStore>,
    input: UsageSettingsInput,
) -> Result<Value, CommandError> {
    if !(1..=365).contains(&input.retention_days) || !(100..=100_000).contains(&input.max_records) {
        return Err(CommandError::new(
            "INVALID_USAGE_SETTINGS",
            "用量设置超出允许范围。",
        ));
    }
    let value = json!({
        "enabled": input.enabled,
        "retentionDays": input.retention_days,
        "maxRecords": input.max_records,
    });
    store.update_settings([("usageSettings".into(), json!(value.to_string()))])?;
    Ok(value)
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_never_claims_a_running_gateway() {
        let settings = normalize_gateway_settings(&serde_json::Map::new());
        assert_eq!(settings["enabled"], false);
        assert_eq!(settings["failoverEnabled"], false);
    }

    #[test]
    fn gateway_settings_normalize_failover_bounds_without_enabling_lan_listen() {
        let settings = normalize_gateway_settings(
            &serde_json::from_value(json!({
                "routeSettings": {
                    "enabled": true,
                    "failoverEnabled": true,
                    "failoverMaxAttempts": 999,
                    "failoverTotalTimeoutMs": 1,
                    "failoverFailureThreshold": 999,
                    "failoverCooldownMs": 9_999_999,
                    "failoverHalfOpenMaxRequests": 0,
                    "allowLANListen": true
                }
            }))
            .unwrap(),
        );
        assert_eq!(settings["enabled"], true);
        assert_eq!(settings["failoverEnabled"], true);
        assert_eq!(settings["failoverMaxAttempts"], 20);
        assert_eq!(settings["failoverTotalTimeoutMs"], 1_000);
        assert_eq!(settings["failoverFailureThreshold"], 100);
        assert_eq!(settings["failoverCooldownMs"], 3_600_000);
        assert_eq!(settings["failoverHalfOpenMaxRequests"], 1);
        assert_eq!(settings["allowLANListen"], false);
        assert_eq!(settings["listenAddress"], "127.0.0.1");
    }

    #[test]
    fn gateway_port_input_rejects_lan_and_out_of_range_values() {
        let invalid = GatewayPortCheckInput {
            listen_address: "0.0.0.0".into(),
            listen_port: 1,
            allow_lan_listen: true,
        };
        assert_eq!(invalid.listen_address, "0.0.0.0");
        assert!(invalid.allow_lan_listen);
        assert!(!(1024..=65_535).contains(&invalid.listen_port));
    }

    #[test]
    fn gateway_lifecycle_flags_are_explicit_and_preserve_other_settings() {
        let mut settings = normalize_gateway_settings(
            &serde_json::from_value(json!({
                "routeSettings": {
                    "autoStart": true,
                    "failoverEnabled": true,
                    "failoverMaxAttempts": 5
                }
            }))
            .unwrap(),
        );
        settings["enabled"] = json!(true);
        settings["disabledExplicitly"] = json!(false);
        assert_eq!(settings["enabled"], true);
        assert_eq!(settings["disabledExplicitly"], false);
        assert_eq!(settings["autoStart"], true);
        assert_eq!(settings["failoverEnabled"], true);
        assert_eq!(settings["failoverMaxAttempts"], 5);
    }

    #[test]
    fn errors_have_stable_codes_and_no_internal_details() {
        let error =
            serde_json::to_value(CommandError::new("INVALID_PREFERENCES", "无效的界面偏好。"))
                .unwrap();
        assert_eq!(
            error,
            json!({
                "code": "INVALID_PREFERENCES",
                "message": "无效的界面偏好。",
                "retryable": false,
            })
        );
    }

    #[test]
    fn old_usage_settings_are_normalized_without_exposing_unknown_fields() {
        assert_eq!(
            normalize_usage_settings(json!({
                "enabled": true, "retentionDays": 500, "maxRecords": "invalid", "apiKey": "secret"
            })),
            json!({ "enabled": true, "retentionDays": 365, "maxRecords": 10000 })
        );
    }

    #[test]
    fn model_validation_endpoint_supports_all_preview_protocols() {
        assert_eq!(
            validation_endpoint("https://example.com/v1", "responses").as_deref(),
            Some("https://example.com/v1/responses")
        );
        assert_eq!(
            validation_endpoint("https://example.com/v1", "chat_completions").as_deref(),
            Some("https://example.com/v1/chat/completions")
        );
        assert_eq!(
            validation_endpoint("https://example.com/v1", "anthropic_messages").as_deref(),
            Some("https://example.com/v1/messages")
        );
        assert!(validation_endpoint("not a url", "responses").is_none());
    }

    #[test]
    fn model_list_parser_collects_nested_ids_and_deduplicates() {
        let mut ids = Vec::new();
        collect_model_ids(
            &json!({"data":[{"id":"gpt-a"},{"name":"gpt-b"}],"models":[{"model":"gpt-a"}]}),
            &mut ids,
        );
        ids.sort();
        ids.dedup();
        assert_eq!(ids, ["gpt-a", "gpt-b"]);
    }

    #[test]
    fn model_list_endpoint_uses_existing_v1_prefix() {
        assert_eq!(
            models_endpoint("https://example.com/v1"),
            "https://example.com/v1/models"
        );
        assert_eq!(
            models_endpoint("https://example.com"),
            "https://example.com/v1/models"
        );
    }

    #[test]
    fn update_asset_filter_accepts_only_project_platform_assets() {
        assert!(asset_matches_platform(
            "Codex-Key-Switcher-1.0.5-arm64.dmg",
            "darwin-arm64"
        ));
        assert!(!asset_matches_platform(
            "other-project-1.0.5-arm64.dmg",
            "darwin-arm64"
        ));
        assert!(asset_matches_platform(
            "Codex-Key-Switcher-1.0.5-amd64.deb",
            "linux-x64"
        ));
        assert!(allowed_release_url(
            "https://github.com/lzwei60/codex-key-switcher/releases/download/v1.0.5/example.dmg"
        ));
        assert!(!allowed_release_url(
            "https://example.com/releases/example.dmg"
        ));
    }
}
