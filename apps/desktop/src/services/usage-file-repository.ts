import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Database as SQLiteDatabase, InitSqlJsStatic, SqlJsStatic, SqlValue } from 'sql.js';
import {
  defaultUsageSettings,
  type UsageAggregateRow,
  type UsageRecord,
  type UsageSettings,
  type UsageStatsInput,
  type UsageStatsSnapshot,
  type UsageSummary,
  type UsageTrendRow,
} from '@codex-key-switcher/shared';
import type { UsageRepository } from '@codex-key-switcher/core';
import { ensurePrivateDirectory, readJsonFile } from './json-file';

type UsageSource = UsageRecord['source'];

interface UsageRow {
  id: string;
  provider: string;
  model: string;
  status: number;
  duration_ms: number;
  source: UsageSource;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  request_id: string | null;
  attempt: number | null;
  failover: number | null;
  final_attempt: number | null;
  error_category: string | null;
  created_at: number;
}

interface SummaryRow {
  total_requests: number;
  successful_requests: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  duration_ms: number | null;
}

interface AggregateSqlRow {
  name: string;
  requests: number;
  successful_requests: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  duration_ms: number | null;
}

interface TrendSqlRow {
  day_key: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
}

interface CountRow {
  total: number;
}

interface UsageAggregateCache {
  summary: UsageSummary;
  trendRows: UsageTrendRow[];
  providerRows: UsageAggregateRow[];
  modelRows: UsageAggregateRow[];
  total: number;
}

const legacyJsonFileName = 'usage-records.json';
const sqliteFileName = 'usage.sqlite';
const sqlWasmJsFileName = 'sql-wasm.js';
const sqlWasmFileName = 'sql-wasm.wasm';
const persistDebounceMs = 1_000;
const retentionCleanupIntervalMs = 60 * 60 * 1_000;
const nodeRequire = createRequire(import.meta.url);
let initSqlJsFactory: InitSqlJsStatic | null = null;
let sqlJsModule: Promise<SqlJsStatic> | null = null;

export class UsageFileRepository implements UsageRepository {
  private database: SQLiteDatabase | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private aggregateCache: UsageAggregateCache | null = null;
  private settings: UsageSettings = { ...defaultUsageSettings };
  private nextRetentionCleanupAt = 0;
  private recordCount: number | null = null;
  private readonly databasePath: string;
  private readonly legacyJsonPath: string;

  constructor(private readonly dataDirectory: string) {
    this.databasePath = path.join(dataDirectory, sqliteFileName);
    this.legacyJsonPath = path.join(dataDirectory, legacyJsonFileName);
  }

  async record(record: UsageRecord): Promise<void> {
    if (!this.settings.enabled) return;
    await this.enqueueWrite(async (database) => {
      insertUsageRecord(database, record);
      this.recordCount = (this.recordCount ?? 0) + 1;
      this.pruneExpiredRecordsIfNeeded(database);
      this.invalidateAggregateCache();
      this.markDirty();
    });
  }

  async configure(settings: UsageSettings): Promise<void> {
    this.settings = normalizeUsageSettings(settings);
    this.nextRetentionCleanupAt = 0;
    await this.enqueueWrite((database) => {
      if (this.pruneExpiredRecordsIfNeeded(database, true)) {
        this.invalidateAggregateCache();
        this.markDirty();
      }
    });
  }

  async snapshot(): Promise<UsageRecord[]> {
    await this.writeQueue;
    const database = await this.open();
    const rows = getAll<UsageRow>(database, 'SELECT * FROM usage_records ORDER BY created_at DESC, rowid DESC');
    return rows.map(recordFromRow);
  }

  async stats(input: UsageStatsInput): Promise<UsageStatsSnapshot> {
    await this.enqueueWrite((database) => {
      if (this.pruneExpiredRecordsIfNeeded(database)) {
        this.invalidateAggregateCache();
        this.markDirty();
      }
    });
    const database = await this.open();
    // Keep large request histories inside SQLite; the renderer only receives the current log page.
    const pageSize = clampInteger(input.logPageSize, 1, 200, 10);
    const page = clampInteger(input.logPage, 1, Number.MAX_SAFE_INTEGER, 1);
    const offset = (page - 1) * pageSize;
    const aggregate = this.aggregateStats(database);
    const rows = getAll<UsageRow>(
      database,
      'SELECT * FROM usage_records ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
      [pageSize, offset],
    );

    return {
      summary: { ...aggregate.summary },
      trendRows: aggregate.trendRows.map((row) => ({ ...row })),
      providerRows: aggregate.providerRows.map((row) => ({ ...row })),
      modelRows: aggregate.modelRows.map((row) => ({ ...row })),
      logs: {
        records: rows.map(recordFromRow),
        total: aggregate.total,
        page,
        pageSize,
      },
    };
  }

  async clearLogs(): Promise<UsageStatsSnapshot> {
    this.clearPersistTimer();
    await this.enqueueWrite(async (database) => {
      run(database, 'DELETE FROM usage_records');
      this.recordCount = 0;
      this.nextRetentionCleanupAt = Date.now() + retentionCleanupIntervalMs;
      this.invalidateAggregateCache();
      this.dirty = true;
      await this.flushDirty(database);
      await Promise.all([
        fs.rm(this.legacyJsonPath, { force: true }),
        fs.rm(`${this.legacyJsonPath}.migrated`, { force: true }),
      ]);
    });
    return this.stats({ logPage: 1, logPageSize: 10 });
  }

  async flush(): Promise<void> {
    this.clearPersistTimer();
    await this.writeQueue;
    const database = await this.open();
    await this.flushDirty(database);
  }

  private async open(): Promise<SQLiteDatabase> {
    if (this.database) return this.database;

    await ensurePrivateDirectory(this.dataDirectory);
    const SQL = await loadSqlJs();
    const data = await fs.readFile(this.databasePath).catch(() => null);
    const database = data ? new SQL.Database(data) : new SQL.Database();
    database.run('PRAGMA foreign_keys = ON');
    migrateSchema(database);
    await this.migrateLegacyJson(database);
    this.database = database;
    this.recordCount = getOne<CountRow>(database, 'SELECT COUNT(*) AS total FROM usage_records')?.total ?? 0;
    return database;
  }

  private async persist(database: SQLiteDatabase): Promise<void> {
    const temporaryPath = `${this.databasePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await ensurePrivateDirectory(this.dataDirectory);
    await fs.writeFile(temporaryPath, database.export(), { mode: 0o600 });
    await fs.rename(temporaryPath, this.databasePath);
    if (process.platform !== 'win32') await fs.chmod(this.databasePath, 0o600).catch(() => undefined);
  }

  private async migrateLegacyJson(database: SQLiteDatabase): Promise<void> {
    const marker = getOne<{ value: string }>(database, 'SELECT value FROM usage_metadata WHERE key = ?', ['legacy_json_migrated']);
    if (marker?.value === 'true') return;

    const payload = await readJsonFile<unknown>(this.legacyJsonPath, []);
    if (Array.isArray(payload)) {
      const records = payload.flatMap((item) => {
        const record = normalizeUsageRecord(item);
        return record ? [record] : [];
      });
      database.run('BEGIN TRANSACTION');
      try {
        for (const record of records.reverse()) {
          insertUsageRecord(database, record);
        }
        database.run('COMMIT');
      } catch (error) {
        database.run('ROLLBACK');
        throw error;
      }
    }

    run(database, 'INSERT OR REPLACE INTO usage_metadata (key, value) VALUES (?, ?)', ['legacy_json_migrated', 'true']);
    await this.persist(database);
    await fs.rename(this.legacyJsonPath, `${this.legacyJsonPath}.migrated`).catch(() => undefined);
  }

  private aggregateStats(database: SQLiteDatabase): UsageAggregateCache {
    if (this.aggregateCache) return this.aggregateCache;
    const aggregate: UsageAggregateCache = {
      summary: usageSummary(database),
      trendRows: usageTrendRows(database),
      providerRows: usageAggregateRows(database, 'provider'),
      modelRows: usageAggregateRows(database, 'model'),
      total: getOne<CountRow>(database, 'SELECT COUNT(*) AS total FROM usage_records')?.total ?? 0,
    };
    this.aggregateCache = aggregate;
    return aggregate;
  }

  private invalidateAggregateCache(): void {
    this.aggregateCache = null;
  }

  private enqueueWrite(operation: (database: SQLiteDatabase) => Promise<void> | void): Promise<void> {
    const nextWrite = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const database = await this.open();
        await operation(database);
      });
    this.writeQueue = nextWrite;
    return nextWrite;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush().catch((error) => {
        console.error('Failed to flush usage records:', error);
      });
    }, persistDebounceMs);
  }

  private clearPersistTimer(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  private async flushDirty(database: SQLiteDatabase): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.persist(database);
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  private pruneExpiredRecordsIfNeeded(database: SQLiteDatabase, force = false): boolean {
    const now = Date.now();
    const exceedsRecordLimit = (this.recordCount ?? 0) > this.settings.maxRecords;
    if (!force && now < this.nextRetentionCleanupAt && !exceedsRecordLimit) return false;

    const previousCount = this.recordCount ?? getOne<CountRow>(database, 'SELECT COUNT(*) AS total FROM usage_records')?.total ?? 0;
    const expiresAt = now - this.settings.retentionDays * 24 * 60 * 60 * 1_000;
    run(database, 'DELETE FROM usage_records WHERE created_at < ?', [expiresAt]);
    run(database, `
      DELETE FROM usage_records
      WHERE rowid NOT IN (
        SELECT rowid
        FROM usage_records
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      )
    `, [this.settings.maxRecords]);
    this.recordCount = getOne<CountRow>(database, 'SELECT COUNT(*) AS total FROM usage_records')?.total ?? 0;
    this.nextRetentionCleanupAt = now + retentionCleanupIntervalMs;
    return this.recordCount !== previousCount;
  }
}

function normalizeUsageSettings(settings: UsageSettings): UsageSettings {
  return {
    enabled: Boolean(settings.enabled),
    retentionDays: clampInteger(settings.retentionDays, 1, 365, defaultUsageSettings.retentionDays),
    maxRecords: clampInteger(settings.maxRecords, 100, 100_000, defaultUsageSettings.maxRecords),
  };
}

function usageSummary(database: SQLiteDatabase): UsageSummary {
  const row = getOne<SummaryRow>(database, `
    SELECT
      COUNT(*) AS total_requests,
      SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS successful_requests,
      SUM(COALESCE(input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(output_tokens, 0)) AS output_tokens,
      SUM(COALESCE(cached_tokens, 0)) AS cached_tokens,
      AVG(duration_ms) AS duration_ms
    FROM usage_records
    WHERE final_attempt IS NOT 0
  `) ?? {
    total_requests: 0,
    successful_requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    duration_ms: 0,
  };
  const totalRequests = row.total_requests;
  const successfulRequests = row.successful_requests;
  const inputTokens = row.input_tokens ?? 0;
  const outputTokens = row.output_tokens ?? 0;
  const cachedTokens = row.cached_tokens ?? 0;
  return {
    totalRequests,
    successfulRequests,
    successRate: percent(successfulRequests, totalRequests),
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
    averageDuration: Math.round(row.duration_ms ?? 0),
  };
}

function usageTrendRows(database: SQLiteDatabase): UsageTrendRow[] {
  const today = startOfDay(Date.now());
  // Return fixed buckets so the chart shape is stable even on days with no traffic.
  const rows: UsageTrendRow[] = Array.from({ length: 8 }, (_, index) => {
    const date = new Date(today - (7 - index) * 24 * 60 * 60 * 1000);
    const key = dateKey(date);
    return {
      key,
      label: `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    };
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const from = today - 7 * 24 * 60 * 60 * 1000;
  const trendRows = getAll<TrendSqlRow>(database, `
    SELECT
      strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day_key,
      SUM(COALESCE(input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(output_tokens, 0)) AS output_tokens,
      SUM(COALESCE(cached_tokens, 0)) AS cached_tokens
    FROM usage_records
    WHERE created_at >= ? AND final_attempt IS NOT 0
    GROUP BY day_key
  `, [from]);

  for (const item of trendRows) {
    const row = byKey.get(item.day_key);
    if (!row) continue;
    row.inputTokens = item.input_tokens ?? 0;
    row.outputTokens = item.output_tokens ?? 0;
    row.cachedTokens = item.cached_tokens ?? 0;
  }
  return rows;
}

function usageAggregateRows(database: SQLiteDatabase, column: 'provider' | 'model'): UsageAggregateRow[] {
  const rows = getAll<AggregateSqlRow>(database, `
    SELECT
      ${column} AS name,
      COUNT(*) AS requests,
      SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS successful_requests,
      SUM(COALESCE(input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(output_tokens, 0)) AS output_tokens,
      SUM(COALESCE(cached_tokens, 0)) AS cached_tokens,
      AVG(duration_ms) AS duration_ms
    FROM usage_records
    WHERE final_attempt IS NOT 0
    GROUP BY ${column}
    ORDER BY requests DESC, name ASC
  `);

  return rows.map((row) => {
    const inputTokens = row.input_tokens ?? 0;
    const outputTokens = row.output_tokens ?? 0;
    const cachedTokens = row.cached_tokens ?? 0;
    return {
      key: row.name,
      name: row.name,
      requests: row.requests,
      successRate: percent(row.successful_requests, row.requests),
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: inputTokens + outputTokens,
      averageDuration: Math.round(row.duration_ms ?? 0),
    };
  });
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function percent(value: number, total: number): number {
  return total ? Math.round((value / total) * 1000) / 10 : 0;
}

function dateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function migrateSchema(database: SQLiteDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_records_created_at ON usage_records (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_records_provider ON usage_records (provider);
    CREATE INDEX IF NOT EXISTS idx_usage_records_model ON usage_records (model);
    CREATE TABLE IF NOT EXISTS usage_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  ensureColumn(database, 'usage_records', 'request_id', 'TEXT');
  ensureColumn(database, 'usage_records', 'attempt', 'INTEGER');
  ensureColumn(database, 'usage_records', 'failover', 'INTEGER');
  ensureColumn(database, 'usage_records', 'final_attempt', 'INTEGER');
  ensureColumn(database, 'usage_records', 'error_category', 'TEXT');
}

function ensureColumn(database: SQLiteDatabase, table: string, column: string, definition: string): void {
  const columns = getAll<{ name: string }>(database, `PRAGMA table_info(${table})`);
  if (!columns.some((entry) => entry.name === column)) database.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function insertUsageRecord(database: SQLiteDatabase, record: UsageRecord): void {
  run(database, `
    INSERT OR REPLACE INTO usage_records (
      id,
      provider,
      model,
      status,
      duration_ms,
      source,
      input_tokens,
      output_tokens,
      cached_tokens,
      request_id,
      attempt,
      failover,
      final_attempt,
      error_category,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.id,
    record.provider,
    record.model,
    record.status,
    record.durationMs,
    record.source,
    record.inputTokens ?? null,
    record.outputTokens ?? null,
    record.cachedTokens ?? null,
    record.requestId ?? null,
    record.attempt ?? null,
    record.failover === undefined ? null : Number(record.failover),
    record.finalAttempt === undefined ? null : Number(record.finalAttempt),
    record.errorCategory ?? null,
    record.createdAt,
  ]);
}

function loadSqlJs(): Promise<SqlJsStatic> {
  const initSqlJs = loadInitSqlJs();
  sqlJsModule ??= initSqlJs({
    locateFile: (fileName) => {
      if (fileName !== sqlWasmFileName) return fileName;
      const candidates = [
        process.resourcesPath ? path.join(process.resourcesPath, 'sql.js', sqlWasmFileName) : '',
        resolvedSqlWasmPath(),
        path.join(process.cwd(), 'node_modules/sql.js/dist', sqlWasmFileName),
      ].filter(Boolean);
      return candidates.find((candidate) => existsSync(candidate)) ?? fileName;
    },
  });
  return sqlJsModule;
}

function loadInitSqlJs(): InitSqlJsStatic {
  if (initSqlJsFactory) return initSqlJsFactory;

  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'sql.js', sqlWasmJsFileName) : '',
    resolvedSqlWasmJsPath(),
  ].filter(Boolean);
  const modulePath = candidates.find((candidate) => existsSync(candidate)) ?? 'sql.js';
  const loaded = nodeRequire(modulePath) as InitSqlJsStatic | { default?: InitSqlJsStatic };
  const factory = typeof loaded === 'function' ? loaded : loaded.default;
  if (!factory) throw new Error('无法加载 sql.js 运行时。');
  initSqlJsFactory = factory;
  return initSqlJsFactory;
}

function resolvedSqlWasmJsPath(): string {
  try {
    return nodeRequire.resolve(`sql.js/dist/${sqlWasmJsFileName}`);
  } catch {
    return '';
  }
}

function resolvedSqlWasmPath(): string {
  try {
    return nodeRequire.resolve(`sql.js/dist/${sqlWasmFileName}`);
  } catch {
    return '';
  }
}

function run(database: SQLiteDatabase, sql: string, params: SqlValue[] = []): void {
  database.run(sql, params);
}

function getOne<T>(database: SQLiteDatabase, sql: string, params: SqlValue[] = []): T | undefined {
  const statement = database.prepare(sql, params);
  try {
    if (!statement.step()) return undefined;
    return statement.getAsObject() as T;
  } finally {
    statement.free();
  }
}

function getAll<T>(database: SQLiteDatabase, sql: string, params: SqlValue[] = []): T[] {
  const statement = database.prepare(sql, params);
  const rows: T[] = [];
  try {
    while (statement.step()) {
      rows.push(statement.getAsObject() as T);
    }
    return rows;
  } finally {
    statement.free();
  }
}

function recordFromRow(row: UsageRow): UsageRecord {
  const record: UsageRecord = {
    id: row.id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    durationMs: row.duration_ms,
    source: row.source,
    createdAt: row.created_at,
  };
  if (row.input_tokens !== null) record.inputTokens = row.input_tokens;
  if (row.output_tokens !== null) record.outputTokens = row.output_tokens;
  if (row.cached_tokens !== null) record.cachedTokens = row.cached_tokens;
  if (row.request_id) record.requestId = row.request_id;
  if (row.attempt !== null) record.attempt = row.attempt;
  if (row.failover !== null) record.failover = Boolean(row.failover);
  if (row.final_attempt !== null) record.finalAttempt = Boolean(row.final_attempt);
  if (row.error_category) record.errorCategory = row.error_category;
  return record;
}

function normalizeUsageRecord(value: unknown): UsageRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<UsageRecord>;
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : crypto.randomUUID();
  const provider = typeof record.provider === 'string' ? record.provider : '';
  const model = typeof record.model === 'string' ? record.model : '';
  const status = numberValue(record.status);
  const durationMs = numberValue(record.durationMs);
  const createdAt = numberValue(record.createdAt) || Date.now();
  const source = isUsageSource(record.source) ? record.source : 'gateway';
  if (!provider || !model || status <= 0) return null;

  const normalized: UsageRecord = {
    id,
    provider,
    model,
    status,
    durationMs,
    source,
    createdAt,
  };
  const inputTokens = optionalNumber(record.inputTokens);
  if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
  const outputTokens = optionalNumber(record.outputTokens);
  if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
  const cachedTokens = optionalNumber(record.cachedTokens);
  if (cachedTokens !== undefined) normalized.cachedTokens = cachedTokens;
  if (typeof record.requestId === 'string' && record.requestId.trim()) normalized.requestId = record.requestId.trim();
  const attempt = optionalNumber(record.attempt);
  if (attempt !== undefined) normalized.attempt = attempt;
  if (typeof record.failover === 'boolean') normalized.failover = record.failover;
  if (typeof record.finalAttempt === 'boolean') normalized.finalAttempt = record.finalAttempt;
  if (typeof record.errorCategory === 'string' && record.errorCategory.trim()) normalized.errorCategory = record.errorCategory.trim();
  return normalized;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

function isUsageSource(value: unknown): value is UsageSource {
  return value === 'responses'
    || value === 'chat_completions'
    || value === 'anthropic_messages'
    || value === 'gateway';
}
