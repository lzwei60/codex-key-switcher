use serde::Deserialize;
use serde_json::{json, Value};

use crate::{commands::CommandError, credentials::SecretBackend, storage::PreviewStore};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    id: Option<String>,
    name: String,
    #[serde(rename = "baseURL")]
    base_url: String,
    api_format: String,
    models: Vec<ModelInput>,
    selected_model: Option<String>,
    api_key: Option<String>,
    tag: Option<String>,
    failover: Option<FailoverInput>,
}

impl ProviderInput {
    pub(crate) fn id(&self) -> Option<&str> {
        self.id.as_deref()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigImportInput {
    pub payload: Value,
    pub credentials: Option<Vec<ProviderConfigCredential>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigCredential {
    pub provider_id: String,
    pub api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FailoverInput {
    enabled: bool,
    priority: i64,
    model_mappings: std::collections::HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelInput {
    custom_name: String,
    model: String,
    api_format: Option<String>,
    supports_reasoning: Option<bool>,
    supports_images: Option<bool>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMigrationPackage {
    format: String,
    schema_version: u8,
    source: String,
    exported_at: i64,
    pub(crate) providers: Vec<Value>,
    pub(crate) credentials: Vec<CredentialMigrationItem>,
    current_provider_id: Option<String>,
}

pub fn credential_migration_payload(
    store: &PreviewStore,
    backend: &impl SecretBackend,
) -> Result<CredentialMigrationPackage, CommandError> {
    let providers = store.list_providers()?;
    let providers = providers
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| CommandError::new("MIGRATION_NO_PROVIDERS", "没有可迁移的供应商。"))?;
    let mut credentials = Vec::with_capacity(providers.len());
    for provider in providers {
        let id = provider["id"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| CommandError::new("MIGRATION_INVALID_PROVIDER", "供应商数据无效。"))?;
        let api_key = backend
            .get(id)?
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                CommandError::new("MIGRATION_MISSING_CREDENTIAL", "供应商缺少可迁移凭据。")
            })?;
        credentials.push(CredentialMigrationItem {
            provider_id: id.to_string(),
            api_key,
        });
    }
    Ok(CredentialMigrationPackage {
        format: "codex-key-switcher-credential-migration".into(),
        schema_version: 1,
        source: "tauri-keyring".into(),
        exported_at: chrono::Utc::now().timestamp_millis(),
        providers: providers.to_vec(),
        credentials,
        current_provider_id: store.current_provider_id()?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(serde::Serialize)]
pub(crate) struct CredentialMigrationItem {
    provider_id: String,
    api_key: String,
}

fn valid_format(value: &str) -> bool {
    matches!(
        value,
        "responses" | "chat_completions" | "anthropic_messages"
    )
}

fn normalize(input: ProviderInput) -> Result<(String, Value, Option<String>), CommandError> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let name = input.name.trim();
    let base_url = input.base_url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(base_url).map_err(|_| invalid_provider())?;
    if id.trim().is_empty()
        || id.len() > 256
        || id.contains('\0')
        || name.is_empty()
        || name.len() > 200
        || name.contains('\0')
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || !valid_format(&input.api_format)
        || input.models.is_empty()
    {
        return Err(invalid_provider());
    }
    let mut names = std::collections::HashSet::new();
    let mut models = Vec::new();
    for model in input.models {
        let custom_name = model.custom_name.trim();
        let upstream = model.model.trim();
        if custom_name.is_empty()
            || upstream.is_empty()
            || !names.insert(custom_name.to_string())
            || model
                .api_format
                .as_deref()
                .is_some_and(|value| !valid_format(value))
        {
            return Err(invalid_provider());
        }
        let mut value = json!({ "customName": custom_name, "model": upstream });
        if let Some(format) = model.api_format {
            value["apiFormat"] = json!(format);
        }
        if let Some(reasoning) = model.supports_reasoning {
            value["supportsReasoning"] = json!(reasoning);
        }
        if let Some(images) = model.supports_images {
            value["supportsImages"] = json!(images);
        }
        models.push(value);
    }
    let selected = input.selected_model.as_deref().unwrap_or("");
    let selected = models
        .iter()
        .find(|model| model["customName"] == selected || model["model"] == selected)
        .unwrap_or(&models[0])["customName"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let mut provider = json!({
        "id": id, "name": name, "baseURL": base_url, "apiFormat": input.api_format,
        "models": models, "selectedModel": selected, "updatedAt": chrono::Utc::now().timestamp_millis(),
        "keyPreview": "需要重新填写 Key",
    });
    if let Some(tag) = input
        .tag
        .as_deref()
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
    {
        provider["tag"] = json!(tag);
    }
    if let Some(failover) = input.failover {
        provider["failover"] = json!({
            "enabled": failover.enabled,
            "priority": failover.priority,
            "modelMappings": failover.model_mappings,
        });
    }
    Ok((
        id,
        provider,
        input
            .api_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty()),
    ))
}

fn invalid_provider() -> CommandError {
    CommandError::new("INVALID_PROVIDER", "供应商配置无效。")
}

pub fn export_provider_metadata(store: &PreviewStore) -> Result<Value, CommandError> {
    let providers = store.list_providers()?;
    let current_id = store.current_provider_id()?.unwrap_or_default();
    Ok(json!({
        "codexKeySwitcherExportVersion": 1,
        "exportedAt": chrono::Utc::now().timestamp_millis(),
        "includesAPIKeys": false,
        "providers": providers,
        "currentProviderId": current_id,
    }))
}

pub fn import_provider_metadata(
    store: &PreviewStore,
    backend: &impl SecretBackend,
    input: ProviderConfigImportInput,
) -> Result<usize, CommandError> {
    let payload = input
        .payload
        .as_object()
        .ok_or_else(invalid_provider_export)?;
    if payload
        .get("codexKeySwitcherExportVersion")
        .and_then(Value::as_i64)
        != Some(1)
        || payload
            .get("includesAPIKeys")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Err(invalid_provider_export());
    }
    let providers = payload
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(invalid_provider_export)?;
    if providers.is_empty() {
        return Ok(0);
    }
    let mut credentials = std::collections::HashMap::new();
    for credential in input.credentials.unwrap_or_default() {
        let id = credential.provider_id.trim().to_string();
        let key = credential.api_key.trim().to_string();
        if id.is_empty() || key.is_empty() || credentials.insert(id, key).is_some() {
            return Err(invalid_provider_export());
        }
    }
    store.provider_transaction(|| {
        store.assert_no_pending_migration()?;
        let existing = store
            .list_providers()?
            .as_array()
            .cloned()
            .unwrap_or_default();
        let existing_ids = existing
            .iter()
            .filter_map(|provider| provider["id"].as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut normalized = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for provider in providers {
            let value = normalize_migration_provider(provider.clone())?;
            let id = value["id"].as_str().unwrap_or_default().to_string();
            if existing_ids.contains(id.as_str()) || !ids.insert(id.clone()) {
                return Err(CommandError::new(
                    "PROVIDER_IMPORT_CONFLICT",
                    "导入配置包含已存在或重复的供应商。",
                ));
            }
            normalized.push(value);
        }
        for provider in &normalized {
            let id = provider["id"].as_str().unwrap_or_default();
            if let Some(key) = credentials.get(id) {
                backend.set(id, key)?;
            }
        }
        let requested_current = payload
            .get("currentProviderId")
            .and_then(Value::as_str)
            .filter(|id| normalized.iter().any(|provider| provider["id"] == *id))
            .map(str::to_string);
        let current_id = requested_current
            .filter(|id| credentials.contains_key(id))
            .or_else(|| {
                existing
                    .first()
                    .and_then(|provider| provider["id"].as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default();
        let mut all = existing;
        all.extend(normalized);
        store.replace_provider_document(&json!({
            "providers": all,
            "currentId": current_id,
        }))?;
        Ok(providers.len())
    })
}

fn invalid_provider_export() -> CommandError {
    CommandError::new(
        "INVALID_PROVIDER_EXPORT",
        "供应商配置文件格式无效或包含不安全字段。",
    )
}

pub fn save_provider(
    store: &PreviewStore,
    backend: &impl SecretBackend,
    input: ProviderInput,
) -> Result<Value, CommandError> {
    let (id, mut provider, new_key) = normalize(input)?;
    store.provider_transaction(|| {
        store.assert_no_pending_migration()?;
        save_provider_locked(store, backend, id, &mut provider, new_key)
    })
}

pub fn delete_provider(
    store: &PreviewStore,
    backend: &impl SecretBackend,
    id: &str,
) -> Result<(), CommandError> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err(CommandError::new("INVALID_PROVIDER_ID", "供应商标识无效。"));
    }
    store.provider_transaction(|| {
        store.assert_no_pending_migration()?;
        let previous = store
            .list_providers()?
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == id))
            .cloned();
        if previous.is_none() {
            return Err(CommandError::new("PROVIDER_NOT_FOUND", "供应商不存在。"));
        }
        let credential = backend.get(&id)?;
        backend.delete(&id)?;
        let result = store.update_providers(|providers, current_id| {
            providers.retain(|item| item["id"] != id);
            if current_id == &id {
                *current_id = providers
                    .first()
                    .and_then(|item| item["id"].as_str())
                    .unwrap_or("")
                    .into();
            }
            Ok(())
        });
        if let Err(error) = result {
            if let Some(value) = credential {
                backend.set(&id, &value)?;
            }
            return Err(error);
        }
        Ok(())
    })
}

pub fn set_current_provider(
    store: &PreviewStore,
    backend: &impl SecretBackend,
    id: &str,
) -> Result<(), CommandError> {
    let id = id.trim().to_string();
    store.provider_transaction(|| {
        store.assert_no_pending_migration()?;
        if backend.get(&id)?.is_none() {
            return Err(CommandError::new(
                "MISSING_CREDENTIAL",
                "供应商缺少安全保存的 API Key。",
            ));
        }
        if !store
            .list_providers()?
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == id))
        {
            return Err(CommandError::new("PROVIDER_NOT_FOUND", "供应商不存在。"));
        }
        store.update_providers(|_, current_id| {
            *current_id = id.clone();
            Ok(())
        })
    })
}

pub fn set_selected_model(store: &PreviewStore, id: &str, model: &str) -> Result<(), CommandError> {
    let id = id.trim().to_string();
    let model = model.trim().to_string();
    store.provider_transaction(|| {
        store.assert_no_pending_migration()?;
        store.update_providers(|providers, _| {
            let provider = providers
                .iter_mut()
                .find(|item| item["id"] == id)
                .ok_or_else(|| CommandError::new("PROVIDER_NOT_FOUND", "供应商不存在。"))?;
            let models = provider["models"].as_array().ok_or_else(invalid_provider)?;
            let selected = models
                .iter()
                .find(|item| item["customName"] == model || item["model"] == model)
                .and_then(|item| item["customName"].as_str())
                .ok_or_else(|| CommandError::new("MODEL_NOT_FOUND", "模型不存在。"))?;
            provider["selectedModel"] = json!(selected);
            provider["updatedAt"] = json!(chrono::Utc::now().timestamp_millis());
            Ok(())
        })
    })
}

pub fn import_credential_migration(
    store: &PreviewStore,
    backend: &impl SecretBackend,
    package: CredentialMigrationPackage,
) -> Result<Value, CommandError> {
    if package.format != "codex-key-switcher-credential-migration"
        || package.schema_version != 1
        || !matches!(
            package.source.as_str(),
            "electron-safe-storage" | "tauri-keyring"
        )
        || package.exported_at <= 0
        || package.providers.is_empty()
    {
        return Err(CommandError::new(
            "INVALID_MIGRATION_PACKAGE",
            "凭据迁移包格式或来源无效。",
        ));
    }

    let mut providers = Vec::with_capacity(package.providers.len());
    let mut provider_ids = std::collections::HashSet::new();
    for provider in package.providers {
        let normalized = normalize_migration_provider(provider)?;
        let id = normalized["id"].as_str().unwrap_or_default().to_string();
        if !provider_ids.insert(id) {
            return Err(CommandError::new(
                "INVALID_MIGRATION_PACKAGE",
                "凭据迁移包包含重复的供应商标识。",
            ));
        }
        providers.push(normalized);
    }

    let mut credentials = std::collections::HashMap::new();
    for item in package.credentials {
        let provider_id = item.provider_id.trim().to_string();
        let api_key = item.api_key.trim().to_string();
        if provider_id.is_empty() || api_key.is_empty() || !provider_ids.contains(&provider_id) {
            return Err(CommandError::new(
                "INVALID_MIGRATION_PACKAGE",
                "凭据迁移包包含无效的供应商凭据。",
            ));
        }
        if credentials.insert(provider_id, api_key).is_some() {
            return Err(CommandError::new(
                "INVALID_MIGRATION_PACKAGE",
                "凭据迁移包包含重复的供应商凭据。",
            ));
        }
    }
    let current_id = package
        .current_provider_id
        .unwrap_or_default()
        .trim()
        .to_string();
    if credentials.len() != provider_ids.len() {
        return Err(CommandError::new(
            "MIGRATION_MISSING_CREDENTIAL",
            "迁移包缺少供应商凭据，未导入任何数据。",
        ));
    }
    if !current_id.is_empty() && !provider_ids.contains(&current_id) {
        return Err(CommandError::new(
            "INVALID_MIGRATION_PACKAGE",
            "凭据迁移包的当前供应商不存在。",
        ));
    }

    store.provider_transaction(|| {
        recover_migration(store, backend)?;
        // Recheck under the same lock as the write to prevent concurrent imports.
        if store.credential_migration_completed()? {
            return Err(CommandError::new(
                "MIGRATION_ALREADY_COMPLETED",
                "凭据迁移已经完成，不能重复导入。",
            ));
        }
        let previous_document = store.provider_document()?;
        if !previous_document["providers"]
            .as_array()
            .is_some_and(|items| items.is_empty())
        {
            return Err(CommandError::new(
                "MIGRATION_TARGET_NOT_EMPTY",
                "Tauri 目标目录已有供应商数据，请先确认并清理隔离预览数据。",
            ));
        }
        let mut previous_credentials = std::collections::HashMap::new();
        for id in &provider_ids {
            let existing = backend.get(id)?;
            if existing.is_some() {
                return Err(CommandError::new(
                    "MIGRATION_CREDENTIAL_CONFLICT",
                    "目标密钥库已有同名凭据，迁移不会覆盖。",
                ));
            }
            previous_credentials.insert(id.clone(), existing);
        }
        let mut written_ids = Vec::new();
        store.write_migration_journal(&json!({
            "schemaVersion": 1, "providerIds": provider_ids,
            "previousDocument": previous_document,
        }))?;
        let mut metadata_written = false;
        let result = (|| {
            for (id, api_key) in &credentials {
                // A backend may mutate before reporting a write error.
                written_ids.push(id.clone());
                backend.set(id, api_key)?;
            }
            let mut providers = providers;
            for provider in &mut providers {
                if credentials.contains_key(provider["id"].as_str().unwrap_or_default()) {
                    provider["keyPreview"] = json!("已安全保存 Key");
                }
            }
            let document = json!({ "providers": providers, "currentId": current_id });
            store.replace_provider_document(&document)?;
            metadata_written = true;
            let completed_at = chrono::Utc::now().timestamp_millis();
            store.mark_credential_migration_completed(
                provider_ids.len(),
                credentials.len(),
                completed_at,
            )?;
            Ok(json!({
                "importedProviderCount": provider_ids.len(),
                "importedCredentialCount": credentials.len(),
                "completedAt": completed_at,
                "sourceCleanupRequired": true,
            }))
        })();
        if result.is_ok() {
            // The completion marker is the commit point. Never undo committed keys.
            store.clear_migration_journal()?;
            return result;
        }

        let mut rollback_failed =
            metadata_written && store.replace_provider_document(&previous_document).is_err();
        for id in written_ids {
            match previous_credentials.get(&id).cloned().flatten() {
                Some(value) => {
                    rollback_failed |= backend.set(&id, &value).is_err();
                }
                None => {
                    rollback_failed |= backend.delete(&id).is_err();
                }
            }
        }
        if rollback_failed {
            return Err(CommandError::new(
                "MIGRATION_ROLLBACK_FAILED",
                "凭据迁移失败且回滚未完全成功，请勿继续使用当前 Tauri 数据目录。",
            ));
        }
        store.clear_migration_journal()?;
        result
    })
}

fn recover_migration(
    store: &PreviewStore,
    backend: &impl SecretBackend,
) -> Result<(), CommandError> {
    let Some(journal) = store.migration_journal()? else {
        return Ok(());
    };
    if store.credential_migration_completed()? {
        return store.clear_migration_journal();
    }
    let invalid = || {
        CommandError::new(
            "MIGRATION_RECOVERY_REQUIRED",
            "迁移日志无效或恢复未完成，请保留日志并检查预览数据。",
        )
    };
    let ids = journal["providerIds"].as_array().ok_or_else(invalid)?;
    let previous = &journal["previousDocument"];
    if journal["schemaVersion"] != 1
        || ids.is_empty()
        || !previous["providers"]
            .as_array()
            .is_some_and(|items| items.is_empty())
        || ids.iter().any(|id| {
            id.as_str()
                .is_none_or(|id| id.is_empty() || id.len() > 256 || id.contains('\0'))
        })
    {
        return Err(invalid());
    }
    // The journal was persisted only after proving all these keyring IDs absent.
    for id in ids {
        backend.delete(id.as_str().ok_or_else(invalid)?)?;
    }
    store.replace_provider_document(previous)?;
    store.clear_migration_journal()
}

fn normalize_migration_provider(value: Value) -> Result<Value, CommandError> {
    let object = value.as_object().ok_or_else(invalid_migration_package)?;
    if object
        .keys()
        .any(|key| matches!(key.as_str(), "apiKey" | "apiKeys" | "keys"))
    {
        return Err(CommandError::new(
            "INVALID_MIGRATION_PACKAGE",
            "凭据迁移包的供应商元数据不能包含内嵌凭据。",
        ));
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let base_url = object
        .get("baseURL")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_end_matches('/');
    let api_format = object
        .get("apiFormat")
        .and_then(Value::as_str)
        .unwrap_or("responses");
    let parsed = url::Url::parse(base_url).map_err(|_| invalid_migration_package())?;
    if id.is_empty()
        || id.len() > 256
        || id.contains('\0')
        || name.is_empty()
        || name.len() > 200
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !valid_format(api_format)
    {
        return Err(invalid_migration_package());
    }
    let models = object
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(invalid_migration_package)?;
    if models.is_empty() {
        return Err(invalid_migration_package());
    }
    let mut normalized_models = Vec::new();
    let mut names = std::collections::HashSet::new();
    for model in models {
        let source = model.as_object().ok_or_else(invalid_migration_package)?;
        let custom_name = source
            .get("customName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let upstream = source
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if custom_name.is_empty() || upstream.is_empty() || !names.insert(custom_name.to_string()) {
            return Err(invalid_migration_package());
        }
        let mut normalized = json!({ "customName": custom_name, "model": upstream });
        if let Some(value) = source.get("apiFormat").and_then(Value::as_str) {
            if !valid_format(value) {
                return Err(invalid_migration_package());
            }
            normalized["apiFormat"] = json!(value);
        }
        for key in ["supportsReasoning", "supportsImages"] {
            if let Some(value) = source.get(key).and_then(Value::as_bool) {
                normalized[key] = json!(value);
            }
        }
        normalized_models.push(normalized);
    }
    let selected = object
        .get("selectedModel")
        .or_else(|| object.get("model"))
        .and_then(Value::as_str)
        .and_then(|target| {
            normalized_models
                .iter()
                .find(|model| model["customName"] == target || model["model"] == target)
        })
        .and_then(|model| model["customName"].as_str())
        .unwrap_or_else(|| {
            normalized_models[0]["customName"]
                .as_str()
                .unwrap_or_default()
        })
        .to_string();
    let mut normalized = json!({
        "id": id,
        "name": name,
        "baseURL": base_url,
        "apiFormat": api_format,
        "models": normalized_models,
        "selectedModel": selected,
        "keyPreview": "需要重新填写 Key",
        "updatedAt": object.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
    });
    if object.get("tag").and_then(Value::as_str).is_some() {
        normalized["tag"] = json!(object["tag"].as_str().unwrap_or_default());
    }
    if let Some(failover) = object.get("failover") {
        let failover = failover.as_object().ok_or_else(invalid_migration_package)?;
        let enabled = failover
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(invalid_migration_package)?;
        let priority = failover
            .get("priority")
            .and_then(Value::as_i64)
            .filter(|value| (0..=10_000).contains(value))
            .ok_or_else(invalid_migration_package)?;
        let mappings = failover
            .get("modelMappings")
            .and_then(Value::as_object)
            .filter(|mappings| mappings.len() <= 100)
            .ok_or_else(invalid_migration_package)?;
        if mappings.iter().any(|(source, target)| {
            let target = target.as_str().unwrap_or("").trim();
            source.trim().is_empty()
                || target.is_empty()
                || !normalized["models"].as_array().is_some_and(|models| {
                    models
                        .iter()
                        .any(|model| model["customName"] == target || model["model"] == target)
                })
        }) {
            return Err(invalid_migration_package());
        }
        normalized["failover"] = json!({
            "enabled": enabled,
            "priority": priority,
            "modelMappings": mappings,
        });
    }
    Ok(normalized)
}

fn invalid_migration_package() -> CommandError {
    CommandError::new("INVALID_MIGRATION_PACKAGE", "凭据迁移包格式无效。")
}

#[allow(dead_code)]
#[derive(Clone)]
pub struct GatewayProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub api_format: String,
}

#[derive(Clone)]
pub struct GatewayCandidate {
    pub provider: GatewayProvider,
    pub failover: bool,
    pub credential_error: Option<&'static str>,
    pub invalid_requested_model: bool,
}

pub fn gateway_provider_candidates(
    store: &PreviewStore,
    backend: &impl SecretBackend,
    requested_model: &str,
    failover_enabled: bool,
) -> Result<Vec<GatewayCandidate>, CommandError> {
    store.assert_no_pending_migration()?;
    let Some(current_id) = store.current_provider_id()? else {
        return Ok(Vec::new());
    };
    let providers = store.list_providers()?;
    let Some(items) = providers.as_array() else {
        return Ok(Vec::new());
    };
    let Some(primary) = items.iter().find(|item| item["id"] == current_id) else {
        return Ok(Vec::new());
    };

    let mut ordered = vec![(primary, false)];
    if failover_enabled {
        let mut backups = items
            .iter()
            .filter(|item| item["id"] != current_id)
            .filter(|item| item["failover"]["enabled"].as_bool().unwrap_or(true))
            .collect::<Vec<_>>();
        backups.sort_by_key(|item| {
            (
                item["failover"]["priority"].as_i64().unwrap_or(100),
                item["updatedAt"].as_i64().unwrap_or(0),
            )
        });
        ordered.extend(backups.into_iter().map(|item| (item, true)));
    }

    let mut candidates = Vec::new();
    for (item, failover) in ordered {
        let Some((mut provider, model_matched)) =
            gateway_provider_from_value(item, requested_model, failover)
        else {
            continue;
        };
        let (api_key, credential_error) = match backend.get(&provider.id) {
            Ok(Some(value)) if !value.trim().is_empty() => (value, None),
            Ok(_) => (String::new(), Some("missing_api_key")),
            Err(_) => (String::new(), Some("credential_error")),
        };
        provider.api_key = api_key;
        candidates.push(GatewayCandidate {
            provider,
            failover,
            credential_error,
            invalid_requested_model: !failover
                && !requested_model.trim().is_empty()
                && !model_matched,
        });
    }
    Ok(candidates)
}

fn gateway_provider_from_value(
    provider: &Value,
    requested_model: &str,
    failover: bool,
) -> Option<(GatewayProvider, bool)> {
    let models = provider["models"].as_array()?;
    let selected = provider["selectedModel"].as_str().unwrap_or("");
    let mapped = failover
        .then(|| {
            provider["failover"]["modelMappings"]
                .get(requested_model)
                .and_then(Value::as_str)
                .unwrap_or("")
        })
        .unwrap_or("");
    let target = if !mapped.trim().is_empty() {
        mapped
    } else if !requested_model.trim().is_empty() {
        requested_model
    } else {
        selected
    };
    let matched_model = models.iter().find(|model| {
        model["customName"] == target
            || model["model"] == target
            || provider_catalog_slug(provider, model).as_deref() == Some(target)
    });
    let model_matched = matched_model.is_some();
    let model = matched_model
        .or_else(|| {
            models.iter().find(|model| {
                model["customName"] == selected
                    || model["model"] == selected
                    || provider_catalog_slug(provider, model).as_deref() == Some(selected)
            })
        })
        .or_else(|| models.first())?;
    let upstream_model = model["model"].as_str()?.trim();
    if upstream_model.is_empty() {
        return None;
    }
    Some((
        GatewayProvider {
            id: provider["id"].as_str()?.to_string(),
            name: provider["name"].as_str().unwrap_or("Provider").to_string(),
            base_url: provider["baseURL"]
                .as_str()
                .unwrap_or("")
                .trim_end_matches('/')
                .to_string(),
            model: upstream_model.to_string(),
            api_key: String::new(),
            api_format: model["apiFormat"]
                .as_str()
                .or_else(|| provider["apiFormat"].as_str())
                .unwrap_or("responses")
                .to_string(),
        },
        model_matched,
    ))
}

#[allow(dead_code)]
pub fn current_gateway_provider(
    store: &PreviewStore,
    backend: &impl SecretBackend,
) -> Result<Option<GatewayProvider>, CommandError> {
    store.assert_no_pending_migration()?;
    let current_id = store.current_provider_id()?;
    let Some(current_id) = current_id else {
        return Ok(None);
    };
    let providers = store.list_providers()?;
    let Some(provider) = providers
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == current_id))
    else {
        return Ok(None);
    };
    let api_key = backend.get(&current_id)?.ok_or_else(|| {
        CommandError::new("MISSING_CREDENTIAL", "当前供应商缺少安全保存的 API Key。")
    })?;
    let Some((mut gateway, _)) = gateway_provider_from_value(provider, "", false) else {
        return Err(CommandError::new(
            "MODEL_NOT_FOUND",
            "当前供应商没有可用模型。",
        ));
    };
    gateway.api_key = api_key;
    Ok(Some(gateway))
}

fn provider_catalog_slug(provider: &Value, model: &Value) -> Option<String> {
    let provider_id = provider["id"].as_str()?.trim();
    let custom_name = model["customName"].as_str()?.trim();
    let upstream_model = model["model"].as_str()?.trim();
    if custom_name.is_empty() || upstream_model.is_empty() {
        return None;
    }
    let safe_name = catalog_safe_name(custom_name);
    let same_name_count = provider["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter(|candidate| {
                    candidate["customName"]
                        .as_str()
                        .map(catalog_safe_name)
                        .is_some_and(|value| value == safe_name)
                })
                .count()
        })
        .unwrap_or(1);
    let suffix = if same_name_count > 1 {
        format!("-{}", stable_model_hash(upstream_model))
    } else {
        String::new()
    };
    Some(format!(
        "ks-{}-{}{}",
        provider_id
            .chars()
            .take(8)
            .collect::<String>()
            .to_lowercase(),
        safe_name,
        suffix
    ))
}

pub(crate) fn catalog_slug_for_model(provider: &Value, model: &Value) -> Option<String> {
    provider_catalog_slug(provider, model)
}

fn catalog_safe_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

fn stable_model_hash(value: &str) -> String {
    let mut hash = 0_u32;
    for unit in value.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as u32);
    }
    let mut digits = if hash == 0 {
        "0".to_string()
    } else {
        let mut number = hash;
        let mut output = String::new();
        while number > 0 {
            let digit = (number % 36) as u8;
            output.push(if digit < 10 {
                (b'0' + digit) as char
            } else {
                (b'a' + digit - 10) as char
            });
            number /= 36;
        }
        output.chars().rev().collect()
    };
    digits.truncate(6);
    while digits.len() < 6 {
        digits.insert(0, '0');
    }
    digits
}

fn save_provider_locked(
    store: &PreviewStore,
    backend: &impl SecretBackend,
    id: String,
    provider: &mut Value,
    new_key: Option<String>,
) -> Result<Value, CommandError> {
    let existing = store.list_providers()?;
    if provider.get("failover").is_none() {
        provider["failover"] = existing
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == id))
            .and_then(|item| item.get("failover"))
            .cloned()
            .unwrap_or_else(|| json!({"enabled": true, "priority": 100, "modelMappings": {}}));
    }
    let failover = &provider["failover"];
    let mappings = failover["modelMappings"]
        .as_object()
        .ok_or_else(invalid_provider)?;
    if failover["priority"]
        .as_i64()
        .is_none_or(|priority| !(0..=10_000).contains(&priority))
        || mappings.len() > 100
        || mappings.iter().any(|(source, target)| {
            let target = target.as_str().unwrap_or("").trim();
            source.trim().is_empty()
                || target.is_empty()
                || !provider["models"].as_array().is_some_and(|models| {
                    models
                        .iter()
                        .any(|model| model["customName"] == target || model["model"] == target)
                })
        })
    {
        return Err(invalid_provider());
    }
    // Existing credentials are fetched only for an explicit save, never for metadata listing.
    let previous_key = backend.get(&id)?;
    if new_key.is_none() && previous_key.is_none() {
        return Err(CommandError::new(
            "MISSING_CREDENTIAL",
            "供应商缺少安全保存的 API Key。",
        ));
    }
    if let Some(key) = &new_key {
        backend.set(&id, key)?;
    }
    let result = store.update_providers(|providers, current_id| {
        let existing = providers.iter().position(|item| item["id"] == id);
        // A missing credential must not authorize editing an unrelated provider ID.
        if existing.is_none() && previous_key.is_some() {
            return Err(CommandError::new(
                "PROVIDER_CONFLICT",
                "供应商标识已被占用。",
            ));
        }
        provider["keyPreview"] = json!("已安全保存 Key");
        if let Some(index) = existing {
            providers[index] = provider.clone();
        } else {
            providers.push(provider.clone());
        }
        providers.sort_by_key(|item| item["updatedAt"].as_i64().unwrap_or(0));
        if current_id.is_empty() {
            *current_id = id.clone();
        }
        Ok(())
    });
    if let Err(error) = result {
        if new_key.is_some() {
            let rollback = match previous_key {
                Some(key) => backend.set(&id, &key),
                None => backend.delete(&id),
            };
            if rollback.is_err() {
                return Err(CommandError::new(
                    "CREDENTIAL_ROLLBACK_FAILED",
                    "凭据回滚失败，请检查系统密钥库。",
                ));
            }
        }
        return Err(error);
    }
    Ok(provider.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};

    #[derive(Default)]
    struct MemorySecrets(Mutex<HashMap<String, String>>);
    impl SecretBackend for MemorySecrets {
        fn set(&self, id: &str, key: &str) -> Result<(), CommandError> {
            self.0.lock().unwrap().insert(id.into(), key.into());
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
    fn input(id: &str, key: Option<&str>) -> ProviderInput {
        ProviderInput {
            id: Some(id.into()),
            name: "Example".into(),
            base_url: "https://example.com/v1".into(),
            api_format: "responses".into(),
            models: vec![ModelInput {
                custom_name: "Alias".into(),
                model: "upstream".into(),
                api_format: None,
                supports_reasoning: None,
                supports_images: None,
            }],
            selected_model: None,
            api_key: key.map(str::to_string),
            tag: None,
            failover: None,
        }
    }
    fn fixture() -> (PathBuf, PreviewStore, MemorySecrets) {
        let root = std::env::temp_dir().join(format!(
            "cksw-provider-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        (
            root.clone(),
            PreviewStore::new(root),
            MemorySecrets::default(),
        )
    }

    fn migration_package() -> CredentialMigrationPackage {
        CredentialMigrationPackage {
            format: "codex-key-switcher-credential-migration".into(),
            schema_version: 1,
            source: "electron-safe-storage".into(),
            exported_at: 1,
            providers: vec![json!({
                "id": "one",
                "name": "Example",
                "baseURL": "https://example.com/v1",
                "apiFormat": "responses",
                "models": [{ "customName": "Alias", "model": "upstream" }],
                "selectedModel": "Alias",
                "updatedAt": 1,
                "keyPreview": "****"
            })],
            credentials: vec![CredentialMigrationItem {
                provider_id: "one".into(),
                api_key: "migrated-secret".into(),
            }],
            current_provider_id: Some("one".into()),
        }
    }

    #[test]
    fn accepts_frontend_provider_input_with_base_url_acronym() {
        let (root, store, secrets) = fixture();
        let input: ProviderInput = serde_json::from_value(json!({
            "id": "frontend", "name": "Frontend", "baseURL": "https://example.com/v1",
            "apiFormat": "responses", "apiKey": "synthetic-secret",
            "models": [{ "customName": "Alias", "model": "upstream" }],
            "selectedModel": "Alias"
        }))
        .unwrap();
        let provider = save_provider(&store, &secrets, input).unwrap();
        assert_eq!(provider["baseURL"], "https://example.com/v1");
        assert_eq!(provider["selectedModel"], "Alias");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn saves_metadata_without_persisting_plaintext() {
        let (root, store, secrets) = fixture();
        let result =
            save_provider(&store, &secrets, input("one", Some("synthetic-secret"))).unwrap();
        assert_eq!(result["id"], "one");
        assert_eq!(
            secrets.get("one").unwrap().as_deref(),
            Some("synthetic-secret")
        );
        assert!(!fs::read_to_string(root.join("providers.json"))
            .unwrap()
            .contains("synthetic-secret"));
        assert_eq!(
            store.list_providers().unwrap()[0]["keyPreview"],
            "已安全保存 Key"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn metadata_failure_restores_previous_credential() {
        let (root, store, secrets) = fixture();
        save_provider(&store, &secrets, input("one", Some("old-secret"))).unwrap();
        let original = fs::read(root.join("providers.json")).unwrap();
        fs::write(root.join("settings.json"), "{}\n").unwrap();
        fs::remove_file(root.join("providers.json")).unwrap();
        fs::create_dir(root.join("providers.json")).unwrap();
        assert!(save_provider(&store, &secrets, input("one", Some("new-secret"))).is_err());
        assert_eq!(secrets.get("one").unwrap().as_deref(), Some("old-secret"));
        assert!(!original.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_input_does_not_touch_credentials() {
        let (root, store, secrets) = fixture();
        let mut bad = input("one", Some("synthetic-secret"));
        bad.base_url = "file:///tmp/key".into();
        assert!(save_provider(&store, &secrets, bad).is_err());
        assert!(secrets.get("one").unwrap().is_none());
        assert!(!root.exists());
    }

    #[test]
    fn failover_settings_survive_save_and_invalid_mapping_is_rejected() {
        let (root, store, secrets) = fixture();
        let mut value = input("one", Some("synthetic-secret"));
        value.failover = Some(FailoverInput {
            enabled: true,
            priority: 2,
            model_mappings: [("source-model".into(), "Alias".into())].into(),
        });
        save_provider(&store, &secrets, value).unwrap();
        let saved = fs::read_to_string(root.join("providers.json")).unwrap();
        assert!(saved.contains("source-model"));
        save_provider(&store, &secrets, input("one", None)).unwrap();
        assert_eq!(
            store.list_providers().unwrap()[0]["failover"]["priority"],
            2
        );
        let mut bad = input("two", Some("another-secret"));
        bad.failover = Some(FailoverInput {
            enabled: true,
            priority: 2,
            model_mappings: [("source-model".into(), "missing-target".into())].into(),
        });
        assert!(save_provider(&store, &secrets, bad).is_err());
        assert!(secrets.get("two").unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provider_lifecycle_survives_reopen_and_blank_key_edit() {
        let (root, store, secrets) = fixture();
        save_provider(&store, &secrets, input("one", Some("first-secret"))).unwrap();
        save_provider(&store, &secrets, input("two", Some("second-secret"))).unwrap();
        set_current_provider(&store, &secrets, "two").unwrap();

        let reopened = PreviewStore::new(root.clone());
        assert_eq!(
            reopened.current_provider_id().unwrap().as_deref(),
            Some("two")
        );
        assert_eq!(
            reopened.list_providers().unwrap().as_array().unwrap().len(),
            2
        );

        save_provider(&reopened, &secrets, input("two", None)).unwrap();
        assert_eq!(
            secrets.get("two").unwrap().as_deref(),
            Some("second-secret")
        );
        assert_eq!(
            reopened.current_provider_id().unwrap().as_deref(),
            Some("two")
        );
        assert_eq!(reopened.list_providers().unwrap()[1]["id"], "two");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_export_is_key_free_and_import_rejects_conflicts_or_embedded_keys() {
        let (root, store, secrets) = fixture();
        save_provider(&store, &secrets, input("one", Some("secret-one"))).unwrap();
        let exported = export_provider_metadata(&store).unwrap();
        assert_eq!(exported["includesAPIKeys"], false);
        assert!(!exported.to_string().contains("secret-one"));

        let (import_root, import_store, import_secrets) = fixture();
        let imported = import_provider_metadata(
            &import_store,
            &import_secrets,
            ProviderConfigImportInput {
                payload: exported.clone(),
                credentials: Some(vec![ProviderConfigCredential {
                    provider_id: "one".into(),
                    api_key: "secret-one".into(),
                }]),
            },
        )
        .unwrap();
        assert_eq!(imported, 1);
        assert_eq!(import_store.list_providers().unwrap()[0]["id"], "one");
        assert_eq!(
            import_secrets.get("one").unwrap().as_deref(),
            Some("secret-one")
        );
        assert!(import_provider_metadata(
            &import_store,
            &import_secrets,
            ProviderConfigImportInput {
                payload: exported.clone(),
                credentials: None
            },
        )
        .is_err());

        let embedded = json!({
            "codexKeySwitcherExportVersion": 1,
            "includesAPIKeys": false,
            "providers": [{
                "id":"embedded", "name":"Embedded", "baseURL":"https://example.com/v1",
                "apiFormat":"responses", "apiKey":"plaintext", "models":[{"customName":"m","model":"m"}]
            }]
        });
        let (embedded_root, embedded_store, embedded_secrets) = fixture();
        assert!(import_provider_metadata(
            &embedded_store,
            &embedded_secrets,
            ProviderConfigImportInput {
                payload: embedded,
                credentials: None
            },
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(import_root).unwrap();
        let _ = fs::remove_dir_all(embedded_root);
    }

    #[test]
    fn gateway_candidates_order_backups_and_apply_model_mapping() {
        let root =
            std::env::temp_dir().join(format!("cksw-provider-candidates-{}", uuid::Uuid::new_v4()));
        let store = PreviewStore::new(root.clone());
        let secrets = MemorySecrets::default();
        for (id, name, priority, model) in [
            ("primary", "Primary", 100, "requested-model"),
            ("backup-late", "Backup Late", 20, "late-model"),
            ("backup-early", "Backup Early", 10, "early-model"),
        ] {
            let mapping = if id == "backup-early" {
                json!({"requested-model": "mapped-model"})
            } else {
                json!({})
            };
            let backup_model = if id == "backup-early" {
                "mapped-model"
            } else {
                model
            };
            let input: ProviderInput = serde_json::from_value(json!({
                "id": id,
                "name": name,
                "baseURL": "https://example.com/v1",
                "apiFormat": "responses",
                "apiKey": format!("key-{id}"),
                "models": [{"customName": "Selected", "model": backup_model}],
                "selectedModel": "Selected",
                "failover": {"enabled": true, "priority": priority, "modelMappings": mapping}
            }))
            .unwrap();
            save_provider(&store, &secrets, input).unwrap();
        }
        set_current_provider(&store, &secrets, "primary").unwrap();
        let candidates =
            gateway_provider_candidates(&store, &secrets, "requested-model", true).unwrap();
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.provider.id.as_str())
                .collect::<Vec<_>>(),
            ["primary", "backup-early", "backup-late"]
        );
        assert_eq!(candidates[1].provider.model, "mapped-model");
        assert!(candidates[1].failover);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gateway_candidates_accept_provider_catalog_slug_for_primary_model() {
        let root = std::env::temp_dir().join(format!(
            "cksw-provider-catalog-slug-{}",
            uuid::Uuid::new_v4()
        ));
        let store = PreviewStore::new(root.clone());
        let secrets = MemorySecrets::default();
        let input: ProviderInput = serde_json::from_value(json!({
            "id": "provider-12345678",
            "name": "Provider",
            "baseURL": "https://example.com/v1",
            "apiFormat": "responses",
            "apiKey": "key",
            "models": [{"customName":"Reasoning Model","model":"upstream-reasoning"}],
            "selectedModel": "Reasoning Model"
        }))
        .unwrap();
        save_provider(&store, &secrets, input).unwrap();
        set_current_provider(&store, &secrets, "provider-12345678").unwrap();
        let candidates =
            gateway_provider_candidates(&store, &secrets, "ks-provider-reasoning-model", false)
                .unwrap();
        assert_eq!(candidates[0].provider.model, "upstream-reasoning");
        assert!(!candidates[0].invalid_requested_model);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn credential_migration_writes_keyring_metadata_and_completion_marker() {
        let (root, store, secrets) = fixture();
        let result = import_credential_migration(&store, &secrets, migration_package()).unwrap();
        assert_eq!(result["importedCredentialCount"], 1);
        assert_eq!(
            secrets.get("one").unwrap().as_deref(),
            Some("migrated-secret")
        );
        assert_eq!(store.current_provider_id().unwrap().as_deref(), Some("one"));
        assert!(store.credential_migration_completed().unwrap());
        assert!(!fs::read_to_string(root.join("providers.json"))
            .unwrap()
            .contains("migrated-secret"));
        let duplicate = import_credential_migration(&store, &secrets, migration_package());
        assert!(duplicate.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    struct FailingMigrationSecrets {
        inner: MemorySecrets,
        writes: std::sync::atomic::AtomicUsize,
        fail_second_write: bool,
        fail_delete: bool,
        break_settings: Option<PathBuf>,
    }

    impl SecretBackend for FailingMigrationSecrets {
        fn set(&self, id: &str, value: &str) -> Result<(), CommandError> {
            self.inner.set(id, value)?;
            if let Some(root) = &self.break_settings {
                fs::create_dir_all(root.join("settings.json")).unwrap();
            }
            if self.fail_second_write
                && self
                    .writes
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    == 1
            {
                return Err(CommandError::new("TEST_WRITE_FAILED", "模拟写入失败。"));
            }
            Ok(())
        }
        fn get(&self, id: &str) -> Result<Option<String>, CommandError> {
            self.inner.get(id)
        }
        fn delete(&self, id: &str) -> Result<(), CommandError> {
            if self.fail_delete {
                return Err(CommandError::new("TEST_DELETE_FAILED", "模拟删除失败。"));
            }
            self.inner.delete(id)
        }
    }

    #[test]
    fn migration_rolls_back_even_when_keyring_mutates_then_fails() {
        for fail_delete in [false, true] {
            let (root, store, _) = fixture();
            let backend = FailingMigrationSecrets {
                inner: MemorySecrets::default(),
                writes: 0.into(),
                fail_second_write: true,
                fail_delete,
                break_settings: None,
            };
            let mut package = migration_package();
            let mut second = package.providers[0].clone();
            second["id"] = json!("two");
            package.providers.push(second);
            package.credentials.push(CredentialMigrationItem {
                provider_id: "two".into(),
                api_key: "second-secret".into(),
            });
            let error = import_credential_migration(&store, &backend, package).unwrap_err();
            assert_eq!(
                error.code(),
                if fail_delete {
                    "MIGRATION_ROLLBACK_FAILED"
                } else {
                    "TEST_WRITE_FAILED"
                }
            );
            if !fail_delete {
                assert!(backend.get("one").unwrap().is_none());
                assert!(backend.get("two").unwrap().is_none());
            }
            assert_eq!(store.migration_journal().unwrap().is_some(), fail_delete);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn migration_completion_write_failure_restores_metadata_and_keys() {
        let (root, store, _) = fixture();
        let original = json!({"providers": [], "currentId": "", "preserved": true});
        store.replace_provider_document(&original).unwrap();
        let backend = FailingMigrationSecrets {
            inner: MemorySecrets::default(),
            writes: 0.into(),
            fail_second_write: false,
            fail_delete: false,
            break_settings: Some(root.clone()),
        };
        assert!(import_credential_migration(&store, &backend, migration_package()).is_err());
        assert_eq!(store.provider_document().unwrap(), original);
        assert!(backend.get("one").unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_migration_recovers_on_retry_without_plaintext_journal() {
        let (root, store, secrets) = fixture();
        let original = json!({"providers": [], "currentId": ""});
        store
            .write_migration_journal(
                &json!({"schemaVersion": 1, "providerIds": ["one"], "previousDocument": original}),
            )
            .unwrap();
        secrets.set("one", "partial-secret").unwrap();
        let mut partial = migration_package().providers;
        partial[0]["keyPreview"] = json!("已安全保存 Key");
        store
            .replace_provider_document(&json!({"providers": partial, "currentId":"one"}))
            .unwrap();
        let reopened = PreviewStore::new(root.clone());
        assert_eq!(
            save_provider(&reopened, &secrets, input("other", Some("new-key")))
                .unwrap_err()
                .code(),
            "MIGRATION_RECOVERY_REQUIRED"
        );
        assert!(
            !fs::read_to_string(root.join("credential-migration-journal.json"))
                .unwrap()
                .contains("partial-secret")
        );
        import_credential_migration(&reopened, &secrets, migration_package()).unwrap();
        assert_eq!(
            secrets.get("one").unwrap().as_deref(),
            Some("migrated-secret")
        );
        assert!(reopened.migration_journal().unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn committed_migration_only_cleans_journal_on_retry() {
        let (root, store, secrets) = fixture();
        import_credential_migration(&store, &secrets, migration_package()).unwrap();
        store.write_migration_journal(&json!({"schemaVersion":1,"providerIds":["one"],"previousDocument":{"providers":[],"currentId":""}})).unwrap();
        let reopened = PreviewStore::new(root.clone());
        assert_eq!(
            import_credential_migration(&reopened, &secrets, migration_package())
                .unwrap_err()
                .code(),
            "MIGRATION_ALREADY_COMPLETED"
        );
        assert_eq!(
            secrets.get("one").unwrap().as_deref(),
            Some("migrated-secret")
        );
        assert!(reopened.migration_journal().unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_rejects_missing_keys_existing_keys_and_invalid_target_metadata() {
        let (root, store, secrets) = fixture();
        let mut missing = migration_package();
        missing.credentials.clear();
        assert_eq!(
            import_credential_migration(&store, &secrets, missing)
                .unwrap_err()
                .code(),
            "MIGRATION_MISSING_CREDENTIAL"
        );
        secrets.set("one", "previous-secret").unwrap();
        assert_eq!(
            import_credential_migration(&store, &secrets, migration_package())
                .unwrap_err()
                .code(),
            "MIGRATION_CREDENTIAL_CONFLICT"
        );
        assert_eq!(
            secrets.get("one").unwrap().as_deref(),
            Some("previous-secret")
        );
        let original = json!({"providers": [{"invalid": true}], "currentId": ""});
        store.replace_provider_document(&original).unwrap();
        assert_eq!(
            import_credential_migration(&store, &secrets, migration_package())
                .unwrap_err()
                .code(),
            "MIGRATION_TARGET_NOT_EMPTY"
        );
        assert_eq!(store.provider_document().unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_saves_leave_metadata_and_credential_consistent() {
        let (root, store, secrets) = fixture();
        std::thread::scope(|threads| {
            for (name, key) in [("First", "first-secret"), ("Second", "second-secret")] {
                let store = &store;
                let secrets = &secrets;
                threads.spawn(move || {
                    let mut value = input("one", Some(key));
                    value.name = name.into();
                    save_provider(store, secrets, value).unwrap();
                });
            }
        });
        let value = store.list_providers().unwrap();
        assert_eq!(value.as_array().unwrap().len(), 1);
        let name = value[0]["name"].as_str().unwrap();
        let credential = secrets.get("one").unwrap().unwrap();
        assert!(matches!(
            (name, credential.as_str()),
            ("First", "first-secret") | ("Second", "second-secret")
        ));
        fs::remove_dir_all(root).unwrap();
    }
}
