import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageFileRepository } from './usage-file-repository';

const temporaryRoots: string[] = [];

describe('UsageFileRepository', () => {
  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('stores all usage records in SQLite without the previous 1000-record cap', async () => {
    const root = await temporaryRoot();
    const repository = new UsageFileRepository(root);

    await Promise.all(Array.from({ length: 1_025 }, (_, index) => repository.record({
      id: `record-${index}`,
      provider: 'provider',
      model: `model-${index}`,
      status: 200,
      durationMs: index,
      source: 'responses',
      createdAt: Date.now() + index,
    })));

    const records = await repository.snapshot();
    expect(records).toHaveLength(1_025);
    expect(new Set(records.map((record) => record.id)).size).toBe(1_025);
    await repository.flush();
    await expect(pathExists(path.join(root, 'usage.sqlite'))).resolves.toBe(true);
  });

  it('limits retained history and can stop recording new usage', async () => {
    const root = await temporaryRoot();
    const repository = new UsageFileRepository(root);
    await repository.configure({ enabled: true, retentionDays: 30, maxRecords: 100 });
    const createdAt = Date.now();

    await Promise.all(Array.from({ length: 101 }, (_, index) => repository.record(usageRecord(`record-${index}`, createdAt + index))));

    expect((await repository.snapshot()).map((record) => record.id)).toHaveLength(100);
    expect((await repository.snapshot()).some((record) => record.id === 'record-0')).toBe(false);

    await repository.configure({ enabled: false, retentionDays: 30, maxRecords: 100 });
    await repository.record(usageRecord('ignored', createdAt + 101));
    expect(await repository.snapshot()).toHaveLength(100);
  });

  it('migrates legacy usage-records.json into SQLite once', async () => {
    const root = await temporaryRoot();
    const createdAt = Date.now() - 1_000;
    await fs.writeFile(path.join(root, 'usage-records.json'), JSON.stringify([
      {
        id: 'legacy-1',
        provider: 'legacy-provider',
        model: 'legacy-model',
        status: 200,
        durationMs: 123,
        source: 'responses',
        inputTokens: 10,
        outputTokens: 20,
        createdAt,
      },
    ]), 'utf8');

    const repository = new UsageFileRepository(root);
    const records = await repository.snapshot();

    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('legacy-1');
    expect(records[0]?.inputTokens).toBe(10);
    await expect(pathExists(path.join(root, 'usage-records.json.migrated'))).resolves.toBe(true);

    const reopened = new UsageFileRepository(root);
    await reopened.record({
      id: 'new-1',
      provider: 'provider',
      model: 'model',
      status: 200,
      durationMs: 1,
      source: 'responses',
      createdAt: createdAt + 1,
    });
    await reopened.flush();
    expect(await reopened.snapshot()).toHaveLength(2);
  });

  it('returns aggregated stats and paginated logs from SQLite', async () => {
    const root = await temporaryRoot();
    const repository = new UsageFileRepository(root);
    const baseTime = new Date('2026-07-30T10:00:00+08:00').getTime();

    await repository.record({
      id: 'first',
      provider: 'provider-a',
      model: 'model-a',
      status: 200,
      durationMs: 100,
      source: 'responses',
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: 3,
      createdAt: baseTime,
    });
    await repository.record({
      id: 'second',
      provider: 'provider-a',
      model: 'model-b',
      status: 502,
      durationMs: 300,
      source: 'chat_completions',
      inputTokens: 5,
      outputTokens: 0,
      createdAt: baseTime + 1000,
    });
    await repository.record({
      id: 'third',
      provider: 'provider-b',
      model: 'model-a',
      status: 201,
      durationMs: 200,
      source: 'responses',
      inputTokens: 7,
      outputTokens: 8,
      createdAt: baseTime + 2000,
    });
    await repository.flush();

    const stats = await repository.stats({ logPage: 2, logPageSize: 2 });

    expect(stats.summary).toMatchObject({
      totalRequests: 3,
      successfulRequests: 2,
      successRate: 66.7,
      inputTokens: 22,
      outputTokens: 28,
      cachedTokens: 3,
      totalTokens: 50,
      averageDuration: 200,
    });
    expect(stats.providerRows.map((row) => [row.name, row.requests])).toEqual([
      ['provider-a', 2],
      ['provider-b', 1],
    ]);
    expect(stats.modelRows.find((row) => row.name === 'model-a')?.requests).toBe(2);
    expect(stats.logs.total).toBe(3);
    expect(stats.logs.records.map((record) => record.id)).toEqual(['first']);
  });

  it('clears request logs and resets aggregated stats', async () => {
    const root = await temporaryRoot();
    const repository = new UsageFileRepository(root);

    await repository.record({
      id: 'record-to-clear',
      provider: 'provider',
      model: 'model',
      status: 200,
      durationMs: 100,
      source: 'responses',
      inputTokens: 10,
      outputTokens: 20,
      createdAt: Date.now(),
    });

    const stats = await repository.clearLogs();

    expect(stats.summary.totalRequests).toBe(0);
    expect(stats.providerRows).toEqual([]);
    expect(stats.modelRows).toEqual([]);
    expect(stats.logs).toMatchObject({
      records: [],
      total: 0,
      page: 1,
      pageSize: 10,
    });
    await expect(repository.snapshot()).resolves.toEqual([]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cksw-usage-test-'));
  temporaryRoots.push(root);
  return root;
}

function usageRecord(id: string, createdAt: number) {
  return {
    id,
    provider: 'provider',
    model: 'model',
    status: 200,
    durationMs: 1,
    source: 'responses' as const,
    createdAt,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}
