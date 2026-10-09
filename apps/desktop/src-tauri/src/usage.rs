use std::{fs, path::Path};

use chrono::{Datelike, Duration, Local, TimeZone};
use rusqlite::{params, Connection, OpenFlags, Row};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::{CommandError, UsageStatsInput};

#[derive(Debug)]
pub enum LegacyUsageMigrationError {
    LegacyInput(CommandError),
    Database(CommandError),
}

impl LegacyUsageMigrationError {
    pub fn is_database_integrity_risk(&self) -> bool {
        matches!(self, Self::Database(_))
    }
}

impl std::fmt::Display for LegacyUsageMigrationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LegacyInput(error) => {
                write!(formatter, "旧版用量 JSON 无法迁移（{}）。", error.code())
            }
            Self::Database(error) => write!(
                formatter,
                "预览用量数据库无法安全迁移（{}）。",
                error.code()
            ),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecordInput {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub status: i64,
    pub duration_ms: i64,
    pub source: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub request_id: Option<String>,
    pub attempt: Option<i64>,
    pub failover: Option<bool>,
    pub final_attempt: Option<bool>,
    pub error_category: Option<String>,
    pub created_at: i64,
}

pub fn record_usage(
    path: &Path,
    record: UsageRecordInput,
    enabled: bool,
    retention_days: i64,
    max_records: i64,
) -> Result<(), CommandError> {
    if !enabled {
        return Ok(());
    }
    if record.id.trim().is_empty()
        || record.provider.trim().is_empty()
        || record.model.trim().is_empty()
        || record.status <= 0
        || record.duration_ms < 0
        || record.created_at <= 0
        || !matches!(
            record.source.as_str(),
            "responses" | "chat_completions" | "anthropic_messages" | "gateway"
        )
        || !(1..=365).contains(&retention_days)
        || !(100..=100_000).contains(&max_records)
    {
        return Err(db_error(()));
    }
    let directory = path.parent().ok_or_else(|| db_error(()))?;
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        _ => return Err(db_error(())),
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err(db_error(())),
    }
    let mut connection = Connection::open(path).map_err(db_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(db_error)?;
    }
    ensure_usage_schema(&connection)?;
    let transaction = connection.transaction().map_err(db_error)?;
    transaction
        .execute(
            "INSERT INTO usage_records (
        id, provider, model, status, duration_ms, source, input_tokens, output_tokens,
        cached_tokens, request_id, attempt, failover, final_attempt, error_category, created_at
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                record.id,
                record.provider,
                record.model,
                record.status,
                record.duration_ms,
                record.source,
                record.input_tokens,
                record.output_tokens,
                record.cached_tokens,
                record.request_id,
                record.attempt,
                record.failover.map(i64::from),
                record.final_attempt.map(i64::from),
                record.error_category,
                record.created_at,
            ],
        )
        .map_err(db_error)?;
    let expires = Local::now().timestamp_millis() - retention_days * 86_400_000;
    transaction
        .execute("DELETE FROM usage_records WHERE created_at < ?1", [expires])
        .map_err(db_error)?;
    transaction
        .execute(
            "DELETE FROM usage_records WHERE rowid NOT IN (
        SELECT rowid FROM usage_records ORDER BY created_at DESC, rowid DESC LIMIT ?1
    )",
            [max_records],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    Ok(())
}

fn ensure_usage_schema(connection: &Connection) -> Result<(), CommandError> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
        status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, source TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, created_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS usage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(db_error)?;
    let columns = column_names(connection)?;
    for (name, definition) in [
        ("request_id", "TEXT"),
        ("attempt", "INTEGER"),
        ("failover", "INTEGER"),
        ("final_attempt", "INTEGER"),
        ("error_category", "TEXT"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection
                .execute(
                    &format!("ALTER TABLE usage_records ADD COLUMN {name} {definition}"),
                    [],
                )
                .map_err(db_error)?;
        }
    }
    Ok(())
}

pub fn migrate_legacy_json(directory: &Path) -> Result<usize, LegacyUsageMigrationError> {
    if !fs::symlink_metadata(directory)
        .map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?
        .file_type()
        .is_dir()
    {
        return Err(LegacyUsageMigrationError::Database(db_error(())));
    }
    let legacy = directory.join("usage-records.json");
    let database = directory.join("usage.sqlite");
    let metadata = match fs::symlink_metadata(&legacy) {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        Ok(_) => {
            return Err(LegacyUsageMigrationError::LegacyInput(
                legacy_migration_error(()),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(LegacyUsageMigrationError::LegacyInput(
                legacy_migration_error(error),
            ))
        }
    };
    if metadata.len() > 64 * 1024 * 1024 {
        return Err(LegacyUsageMigrationError::LegacyInput(
            legacy_migration_error(()),
        ));
    }
    let payload: Value =
        serde_json::from_slice(&fs::read(&legacy).map_err(|error| {
            LegacyUsageMigrationError::LegacyInput(legacy_migration_error(error))
        })?)
        .map_err(|error| LegacyUsageMigrationError::LegacyInput(legacy_migration_error(error)))?;
    let records = payload
        .as_array()
        .ok_or_else(|| LegacyUsageMigrationError::LegacyInput(legacy_migration_error(())))?;
    let database_exists = match fs::symlink_metadata(&database) {
        Ok(info) if info.file_type().is_file() => true,
        Ok(_) => return Err(LegacyUsageMigrationError::Database(db_error(()))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(LegacyUsageMigrationError::Database(db_error(error))),
    };
    let mut connection = Connection::open(&database)
        .map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&database, fs::Permissions::from_mode(0o600))
            .map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?;
    }
    let integrity: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?;
    if integrity != "ok" {
        return Err(LegacyUsageMigrationError::Database(db_error(())));
    }
    if database_exists {
        let columns = column_names(&connection).map_err(LegacyUsageMigrationError::Database)?;
        let required = [
            "id",
            "provider",
            "model",
            "status",
            "duration_ms",
            "source",
            "input_tokens",
            "output_tokens",
            "cached_tokens",
            "created_at",
        ];
        if required
            .iter()
            .any(|required| !columns.iter().any(|column| column == required))
        {
            return Err(LegacyUsageMigrationError::Database(db_error(())));
        }
    }
    ensure_usage_schema(&connection).map_err(LegacyUsageMigrationError::Database)?;
    let transaction = connection
        .transaction()
        .map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS usage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )
        .map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?;
    let migrated: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM usage_metadata WHERE key = 'legacy_json_migrated' AND value = 'true')",
        [], |row| row.get(0),
    ).map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?;
    if migrated {
        return Ok(0);
    }
    let mut inserted = 0;
    for record in records.iter().rev() {
        let Some(provider) = record
            .get("provider")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(model) = record
            .get("model")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(status) = record
            .get("status")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
        else {
            continue;
        };
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let duration = record
            .get("durationMs")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let created = record
            .get("createdAt")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .unwrap_or_else(|| Local::now().timestamp_millis());
        let source = record
            .get("source")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "responses" | "chat_completions" | "anthropic_messages" | "gateway"
                )
            })
            .unwrap_or("gateway");
        let count = transaction
            .execute(
                "INSERT OR IGNORE INTO usage_records (
            id, provider, model, status, duration_ms, source, input_tokens,
            output_tokens, cached_tokens, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    id,
                    provider,
                    model,
                    status,
                    duration,
                    source,
                    record
                        .get("inputTokens")
                        .and_then(Value::as_i64)
                        .map(|value| value.max(0)),
                    record
                        .get("outputTokens")
                        .and_then(Value::as_i64)
                        .map(|value| value.max(0)),
                    record
                        .get("cachedTokens")
                        .and_then(Value::as_i64)
                        .map(|value| value.max(0)),
                    created,
                ],
            )
            .map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?;
        inserted += count;
    }
    transaction.execute("INSERT OR REPLACE INTO usage_metadata (key, value) VALUES ('legacy_json_migrated', 'true')", [])
        .map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?;
    transaction
        .commit()
        .map_err(|error| LegacyUsageMigrationError::Database(db_error(error)))?;
    // Preserve an existing archive. A failed rename leaves the source intact;
    // the committed marker keeps retries idempotent.
    let archive = directory.join("usage-records.json.migrated");
    if !archive.exists() {
        let _ = fs::rename(&legacy, archive);
    }
    Ok(inserted)
}

pub fn clear_logs(path: &Path) -> Result<Value, CommandError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_stats(1, 10));
        }
        Ok(metadata) if metadata.file_type().is_file() => {}
        _ => return Err(db_error(())),
    }
    let mut connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(db_error)?;
    if column_names(&connection)?.is_empty() {
        return Err(db_error(()));
    }
    let transaction = connection.transaction().map_err(db_error)?;
    transaction
        .execute("DELETE FROM usage_records", [])
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    read_stats(
        path,
        UsageStatsInput {
            log_page: 1,
            log_page_size: 10,
        },
    )
}

pub fn read_stats(path: &Path, input: UsageStatsInput) -> Result<Value, CommandError> {
    let page = input.log_page.max(1);
    let page_size = input.log_page_size.clamp(1, 200);
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_stats(page, page_size))
        }
        Ok(metadata) if metadata.file_type().is_file() => {}
        _ => return Err(db_error(())),
    }
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(db_error)?;
    let columns = column_names(&connection)?;
    if columns.is_empty() {
        return Err(db_error(()));
    }
    let final_filter = if columns.iter().any(|column| column == "final_attempt") {
        "WHERE final_attempt IS NOT 0"
    } else {
        ""
    };
    let summary = connection.query_row(&format!("
        SELECT COUNT(*),
          SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END),
          SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)),
          SUM(COALESCE(cached_tokens, 0)), AVG(duration_ms)
        FROM usage_records {final_filter}
    "), [], |row| {
        let total: i64 = row.get(0)?;
        let success: i64 = row.get::<_, Option<i64>>(1)?.unwrap_or(0);
        let input: i64 = row.get::<_, Option<i64>>(2)?.unwrap_or(0);
        let output: i64 = row.get::<_, Option<i64>>(3)?.unwrap_or(0);
        let cached: i64 = row.get::<_, Option<i64>>(4)?.unwrap_or(0);
        let average: Option<f64> = row.get(5)?;
        Ok(json!({
            "totalRequests": total, "successfulRequests": success,
            "successRate": percent(success, total), "inputTokens": input,
            "outputTokens": output, "cachedTokens": cached,
            "totalTokens": input + output, "averageDuration": average.unwrap_or(0.0).round() as i64,
        }))
    }).map_err(db_error)?;

    let total: i64 = connection
        .query_row("SELECT COUNT(*) FROM usage_records", [], |row| row.get(0))
        .map_err(db_error)?;
    let offset = i64::from(page.saturating_sub(1)).saturating_mul(i64::from(page_size));
    let optional = |name: &str| {
        if columns.iter().any(|column| column == name) {
            name.to_string()
        } else {
            "NULL".into()
        }
    };
    let query = format!(
        "
        SELECT id, provider, model, status, duration_ms, source,
          input_tokens, output_tokens, cached_tokens, created_at,
          {}, {}, {}, {}, {}
        FROM usage_records ORDER BY created_at DESC, rowid DESC LIMIT ?1 OFFSET ?2
    ",
        optional("request_id"),
        optional("attempt"),
        optional("failover"),
        optional("final_attempt"),
        optional("error_category")
    );
    let mut statement = connection.prepare(&query).map_err(db_error)?;
    let records = statement
        .query_map(params![page_size, offset], record_from_row)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    Ok(json!({
        "summary": summary,
        "trendRows": trend_rows(&connection, final_filter)?,
        "providerRows": aggregate_rows(&connection, "provider", final_filter)?,
        "modelRows": aggregate_rows(&connection, "model", final_filter)?,
        "logs": { "records": records, "total": total, "page": page, "pageSize": page_size },
    }))
}

fn column_names(connection: &Connection) -> Result<Vec<String>, CommandError> {
    let mut statement = connection
        .prepare("PRAGMA table_info(usage_records)")
        .map_err(db_error)?;
    let columns = statement
        .query_map([], |row| row.get(1))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(columns)
}

fn record_from_row(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut record = json!({
        "id": row.get::<_, String>(0)?, "provider": row.get::<_, String>(1)?,
        "model": row.get::<_, String>(2)?, "status": row.get::<_, i64>(3)?,
        "durationMs": row.get::<_, i64>(4)?, "source": row.get::<_, String>(5)?,
        "createdAt": row.get::<_, i64>(9)?,
    });
    for (index, name) in [
        (6, "inputTokens"),
        (7, "outputTokens"),
        (8, "cachedTokens"),
        (10, "requestId"),
        (11, "attempt"),
        (14, "errorCategory"),
    ] {
        let value: Value = match index {
            10 | 14 => row
                .get::<_, Option<String>>(index)?
                .map_or(Value::Null, Value::String),
            _ => row
                .get::<_, Option<i64>>(index)?
                .map_or(Value::Null, |number| json!(number)),
        };
        if !value.is_null() {
            record[name] = value;
        }
    }
    for (index, name) in [(12, "failover"), (13, "finalAttempt")] {
        if let Some(value) = row.get::<_, Option<i64>>(index)? {
            record[name] = json!(value != 0);
        }
    }
    Ok(record)
}

fn aggregate_rows(
    connection: &Connection,
    column: &str,
    filter: &str,
) -> Result<Vec<Value>, CommandError> {
    let query = format!(
        "
        SELECT {column}, COUNT(*),
          SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END),
          SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)),
          SUM(COALESCE(cached_tokens, 0)), AVG(duration_ms)
        FROM usage_records {filter} GROUP BY {column} ORDER BY COUNT(*) DESC, {column} ASC
    "
    );
    let mut statement = connection.prepare(&query).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            let name: String = row.get(0)?;
            let requests: i64 = row.get(1)?;
            let successes: i64 = row.get(2)?;
            let input: i64 = row.get(3)?;
            let output: i64 = row.get(4)?;
            let cached: i64 = row.get(5)?;
            let average: Option<f64> = row.get(6)?;
            Ok(json!({
                "key": name, "name": name, "requests": requests,
                "successRate": percent(successes, requests), "inputTokens": input,
                "outputTokens": output, "cachedTokens": cached, "totalTokens": input + output,
                "averageDuration": average.unwrap_or(0.0).round() as i64,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn trend_rows(connection: &Connection, filter: &str) -> Result<Vec<Value>, CommandError> {
    let today = Local::now().date_naive();
    let start = Local
        .from_local_datetime(&today.and_hms_opt(0, 0, 0).expect("valid midnight"))
        .earliest()
        .expect("local midnight")
        .timestamp_millis()
        - 7 * 86_400_000;
    let mut statement = connection.prepare(&format!("
        SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime'),
          SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)), SUM(COALESCE(cached_tokens, 0))
        FROM usage_records WHERE created_at >= ?1 {} GROUP BY 1
    ", if filter.is_empty() { "" } else { "AND final_attempt IS NOT 0" })).map_err(db_error)?;
    let totals = statement
        .query_map([start], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ),
            ))
        })
        .map_err(db_error)?
        .collect::<Result<std::collections::HashMap<_, _>, _>>()
        .map_err(db_error)?;
    Ok(trend_buckets(&totals))
}

fn trend_buckets(totals: &std::collections::HashMap<String, (i64, i64, i64)>) -> Vec<Value> {
    let today = Local::now().date_naive();
    (0..8)
        .map(|index| {
            let day = today - Duration::days(7 - index);
            let key = day.format("%Y-%m-%d").to_string();
            let (input, output, cached) = totals.get(&key).copied().unwrap_or((0, 0, 0));
            json!({ "key": key, "label": format!("{:02}/{:02}", day.month(), day.day()),
              "inputTokens": input, "outputTokens": output, "cachedTokens": cached })
        })
        .collect()
}

fn empty_stats(page: u32, page_size: u32) -> Value {
    json!({
        "summary": { "totalRequests": 0, "successfulRequests": 0, "successRate": 0,
            "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "totalTokens": 0, "averageDuration": 0 },
        "trendRows": trend_buckets(&std::collections::HashMap::new()), "providerRows": [], "modelRows": [],
        "logs": { "records": [], "total": 0, "page": page, "pageSize": page_size },
    })
}

fn percent(value: i64, total: i64) -> f64 {
    if total == 0 {
        0.0
    } else {
        ((value as f64 / total as f64) * 1000.0).round() / 10.0
    }
}

fn db_error(_: impl std::fmt::Debug) -> CommandError {
    CommandError::new("USAGE_READ_FAILED", "读取预览用量数据库失败。")
}

fn legacy_migration_error(_: impl std::fmt::Debug) -> CommandError {
    CommandError::new("INVALID_LEGACY_USAGE", "旧版用量记录文件无法解析。")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, created_at: i64) -> UsageRecordInput {
        UsageRecordInput {
            id: id.into(),
            provider: "test-provider".into(),
            model: "test-model".into(),
            status: 200,
            duration_ms: 12,
            source: "responses".into(),
            input_tokens: Some(2),
            output_tokens: Some(3),
            cached_tokens: None,
            request_id: None,
            attempt: None,
            failover: None,
            final_attempt: Some(true),
            error_category: None,
            created_at,
        }
    }

    fn test_nonce() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn missing_database_does_not_create_a_file() {
        let root = std::env::temp_dir().join(format!("cksw-usage-missing-{}", std::process::id()));
        let path = root.join("usage.sqlite");
        let stats = read_stats(
            &path,
            UsageStatsInput {
                log_page: 1,
                log_page_size: 20,
            },
        )
        .unwrap();
        assert_eq!(stats["summary"]["totalRequests"], 0);
        assert_eq!(stats["trendRows"].as_array().unwrap().len(), 8);
        assert!(!path.exists());
        let cleared = clear_logs(&path).unwrap();
        assert_eq!(cleared["logs"]["total"], 0);
        assert!(!path.exists());
    }

    #[test]
    fn reads_existing_sqlite_without_modifying_it() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-fixture-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("usage.sqlite");
        let now = Local::now().timestamp_millis();
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE usage_records (
                id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
                status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, source TEXT NOT NULL,
                input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
                created_at INTEGER NOT NULL, request_id TEXT, attempt INTEGER,
                failover INTEGER, final_attempt INTEGER, error_category TEXT);",
            )
            .unwrap();
            for (
                id,
                provider,
                model,
                status,
                duration,
                input,
                output,
                cached,
                final_attempt,
                offset,
            ) in [
                ("a", "provider-a", "model-a", 200, 100, 10, 20, 3, 1, -2000),
                ("b", "provider-a", "model-b", 502, 300, 5, 0, 0, 1, -1000),
                ("c", "provider-b", "model-a", 201, 200, 7, 8, 0, 1, 0),
                (
                    "retry",
                    "provider-b",
                    "model-a",
                    503,
                    50,
                    100,
                    100,
                    0,
                    0,
                    1000,
                ),
            ] {
                db.execute(
                    "INSERT INTO usage_records (id, provider, model, status, duration_ms, source,
                    input_tokens, output_tokens, cached_tokens, created_at, final_attempt)
                    VALUES (?1, ?2, ?3, ?4, ?5, 'responses', ?6, ?7, ?8, ?9, ?10)",
                    params![
                        id,
                        provider,
                        model,
                        status,
                        duration,
                        input,
                        output,
                        cached,
                        now + offset,
                        final_attempt
                    ],
                )
                .unwrap();
            }
        }
        let before = std::fs::read(&path).unwrap();
        let stats = read_stats(
            &path,
            UsageStatsInput {
                log_page: 2,
                log_page_size: 2,
            },
        )
        .unwrap();
        assert_eq!(stats["summary"]["totalRequests"], 3);
        assert_eq!(stats["summary"]["successfulRequests"], 2);
        assert_eq!(stats["summary"]["successRate"], 66.7);
        assert_eq!(stats["summary"]["totalTokens"], 50);
        assert_eq!(stats["summary"]["averageDuration"], 200);
        assert_eq!(stats["logs"]["total"], 4);
        assert_eq!(stats["logs"]["records"][0]["id"], "b");
        assert_eq!(stats["providerRows"][0]["name"], "provider-a");
        assert_eq!(stats["modelRows"][0]["requests"], 2);
        assert_eq!(stats["trendRows"].as_array().unwrap().len(), 8);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_existing_table_has_numeric_zero_summary() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-empty-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("usage.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE usage_records (id TEXT, provider TEXT, model TEXT, status INTEGER,
            duration_ms INTEGER, source TEXT, input_tokens INTEGER, output_tokens INTEGER,
            cached_tokens INTEGER, created_at INTEGER);",
        )
        .unwrap();
        drop(db);
        let stats = read_stats(
            &path,
            UsageStatsInput {
                log_page: 1,
                log_page_size: 10,
            },
        )
        .unwrap();
        assert_eq!(stats["summary"]["inputTokens"], 0);
        assert_eq!(stats["summary"]["successRate"].as_f64(), Some(0.0));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clears_only_an_existing_isolated_database() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-clear-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("usage.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE usage_records (id TEXT, provider TEXT, model TEXT,
            status INTEGER, duration_ms INTEGER, source TEXT, input_tokens INTEGER,
            output_tokens INTEGER, cached_tokens INTEGER, created_at INTEGER);
            INSERT INTO usage_records VALUES ('one','provider','model',200,10,'responses',1,2,0,1000);").unwrap();
        drop(db);
        let stats = clear_logs(&path).unwrap();
        assert_eq!(stats["logs"]["total"], 0);
        assert_eq!(stats["summary"]["totalRequests"], 0);
        assert_eq!(stats["trendRows"].as_array().unwrap().len(), 8);
        assert!(path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_rows_without_failover_columns_remain_readable() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-legacy-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("usage.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE usage_records (id TEXT PRIMARY KEY, provider TEXT NOT NULL,
            model TEXT NOT NULL, status INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
            source TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
            cached_tokens INTEGER, created_at INTEGER NOT NULL);
            INSERT INTO usage_records VALUES ('legacy','prior','old-model',200,25,'responses',4,6,NULL,12345);").unwrap();
        drop(db);
        let before = std::fs::read(&path).unwrap();
        let stats = read_stats(
            &path,
            UsageStatsInput {
                log_page: 1,
                log_page_size: 10,
            },
        )
        .unwrap();
        assert_eq!(stats["summary"]["totalRequests"], 1);
        assert_eq!(stats["summary"]["totalTokens"], 10);
        assert_eq!(stats["logs"]["records"][0]["id"], "legacy");
        assert!(stats["logs"]["records"][0].get("finalAttempt").is_none());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_database_symlink() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-link-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("usage.sqlite");
        symlink(root.join("outside.sqlite"), &path).unwrap();
        let result = read_stats(
            &path,
            UsageStatsInput {
                log_page: 1,
                log_page_size: 10,
            },
        );
        assert!(result.is_err());
        assert!(clear_logs(&path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_schema_cannot_be_cleared() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-invalid-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("usage.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE unrelated (id TEXT);")
            .unwrap();
        drop(db);
        let before = std::fs::read(&path).unwrap();
        assert!(clear_logs(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrates_legacy_json_once_without_reimporting_after_retry() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-migrate-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = Connection::open(root.join("usage.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE usage_records (id TEXT PRIMARY KEY, provider TEXT, model TEXT,
            status INTEGER, duration_ms INTEGER, source TEXT, input_tokens INTEGER,
            output_tokens INTEGER, cached_tokens INTEGER, created_at INTEGER);",
        )
        .unwrap();
        drop(db);
        let payload = json!([
            {"id":"legacy-1", "provider":"prior", "model":"old-model", "status":200,
             "durationMs":20, "source":"responses", "inputTokens":3, "outputTokens":4, "createdAt":12345},
            {"id":"bad", "provider":"", "model":"old-model", "status":200}
        ]);
        std::fs::write(root.join("usage-records.json"), payload.to_string()).unwrap();
        assert_eq!(migrate_legacy_json(&root).unwrap(), 1);
        assert!(root.join("usage-records.json.migrated").exists());
        std::fs::write(root.join("usage-records.json"), payload.to_string()).unwrap();
        assert_eq!(migrate_legacy_json(&root).unwrap(), 0);
        assert!(root.join("usage-records.json").exists());
        let stats = read_stats(
            &root.join("usage.sqlite"),
            UsageStatsInput {
                log_page: 1,
                log_page_size: 10,
            },
        )
        .unwrap();
        assert_eq!(stats["summary"]["totalTokens"], 7);
        assert_eq!(stats["logs"]["total"], 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_legacy_json_is_a_noop_without_creating_a_database() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-no-legacy-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(migrate_legacy_json(&root).unwrap(), 0);
        assert!(!root.join("usage.sqlite").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_json_creates_the_database_on_first_startup_migration() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-first-migration-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let payload = json!([{
            "id": "legacy-first",
            "provider": "prior",
            "model": "old-model",
            "status": 200,
            "durationMs": 20,
            "source": "responses",
            "inputTokens": 3,
            "outputTokens": 4,
            "createdAt": 12345
        }]);
        std::fs::write(root.join("usage-records.json"), payload.to_string()).unwrap();
        assert_eq!(migrate_legacy_json(&root).unwrap(), 1);
        assert!(root.join("usage.sqlite").is_file());
        assert!(root.join("usage-records.json.migrated").is_file());
        let stats = read_stats(
            &root.join("usage.sqlite"),
            UsageStatsInput {
                log_page: 1,
                log_page_size: 10,
            },
        )
        .unwrap();
        assert_eq!(stats["logs"]["total"], 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_legacy_json_does_not_mutate_database() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-invalid-migration-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = Connection::open(root.join("usage.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE usage_records (id TEXT PRIMARY KEY, provider TEXT, model TEXT,
            status INTEGER, duration_ms INTEGER, source TEXT, input_tokens INTEGER,
            output_tokens INTEGER, cached_tokens INTEGER, created_at INTEGER);",
        )
        .unwrap();
        drop(db);
        let before = std::fs::read(root.join("usage.sqlite")).unwrap();
        std::fs::write(root.join("usage-records.json"), "not-json").unwrap();
        assert!(migrate_legacy_json(&root).is_err());
        assert_eq!(std::fs::read(root.join("usage.sqlite")).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_legacy_json_does_not_create_a_database() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-invalid-first-migration-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("usage-records.json"), "not-json").unwrap();
        let error = migrate_legacy_json(&root).unwrap_err();
        assert!(!error.is_database_integrity_risk());
        assert!(!root.join("usage.sqlite").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("usage-records.json")).unwrap(),
            "not-json"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_existing_database_blocks_migration_without_mutation() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-invalid-database-migration-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("usage-records.json"), "[]").unwrap();
        let database = root.join("usage.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch("CREATE TABLE unrelated (id TEXT);")
            .unwrap();
        drop(connection);
        let before = std::fs::read(&database).unwrap();
        let error = migrate_legacy_json(&root).unwrap_err();
        assert!(error.is_database_integrity_risk());
        assert_eq!(std::fs::read(&database).unwrap(), before);
        assert!(root.join("usage-records.json").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_does_not_overwrite_existing_archive() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-archive-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = Connection::open(root.join("usage.sqlite")).unwrap();
        db.execute_batch(
            "CREATE TABLE usage_records (id TEXT PRIMARY KEY, provider TEXT, model TEXT,
            status INTEGER, duration_ms INTEGER, source TEXT, input_tokens INTEGER,
            output_tokens INTEGER, cached_tokens INTEGER, created_at INTEGER);",
        )
        .unwrap();
        drop(db);
        std::fs::write(root.join("usage-records.json.migrated"), "old archive").unwrap();
        std::fs::write(root.join("usage-records.json"), "[]").unwrap();
        assert_eq!(migrate_legacy_json(&root).unwrap(), 0);
        assert_eq!(
            std::fs::read_to_string(root.join("usage-records.json.migrated")).unwrap(),
            "old archive"
        );
        assert!(root.join("usage-records.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn migration_rejects_a_linked_directory() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "cksw-migration-link-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        let actual = root.join("actual");
        std::fs::create_dir_all(&actual).unwrap();
        let link = root.join("linked");
        symlink(&actual, &link).unwrap();
        assert!(migrate_legacy_json(&link).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disabled_recording_does_not_create_a_database() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-disabled-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        let path = root.join("usage.sqlite");
        record_usage(
            &path,
            record("disabled", Local::now().timestamp_millis()),
            false,
            30,
            100,
        )
        .unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn invalid_record_is_rejected_before_database_creation() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-reject-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("usage.sqlite");
        let mut invalid = record("invalid", Local::now().timestamp_millis());
        invalid.provider.clear();
        assert!(record_usage(&path, invalid, true, 30, 100).is_err());
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn records_usage_into_legacy_schema_and_prunes_oldest_rows() {
        let root = std::env::temp_dir().join(format!(
            "cksw-usage-record-{}-{}",
            std::process::id(),
            test_nonce()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("usage.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE usage_records (id TEXT PRIMARY KEY, provider TEXT, model TEXT,
            status INTEGER, duration_ms INTEGER, source TEXT, input_tokens INTEGER,
            output_tokens INTEGER, cached_tokens INTEGER, created_at INTEGER);",
        )
        .unwrap();
        drop(db);
        let now = Local::now().timestamp_millis();
        record_usage(
            &path,
            record("expired", now - 40 * 86_400_000),
            true,
            30,
            100,
        )
        .unwrap();
        for index in 0..101 {
            record_usage(
                &path,
                record(&format!("item-{index}"), now + index),
                true,
                30,
                100,
            )
            .unwrap();
        }
        let stats = read_stats(
            &path,
            UsageStatsInput {
                log_page: 1,
                log_page_size: 10,
            },
        )
        .unwrap();
        assert_eq!(stats["summary"]["totalRequests"], 100);
        assert_eq!(stats["summary"]["totalTokens"], 500);
        assert_eq!(stats["logs"]["total"], 100);
        let db = Connection::open(&path).unwrap();
        let oldest: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM usage_records WHERE id = 'item-0'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(oldest, 0);
        let columns = column_names(&db).unwrap();
        assert!(columns.iter().any(|name| name == "final_attempt"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
