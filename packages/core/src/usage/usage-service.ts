import type { UsageRecord, UsageStatsInput, UsageStatsSnapshot } from '@codex-key-switcher/shared';

export interface UsageRepository {
  record(record: UsageRecord): Promise<void>;
  snapshot(): Promise<UsageRecord[]>;
  stats(input: UsageStatsInput): Promise<UsageStatsSnapshot>;
  clearLogs(): Promise<UsageStatsSnapshot>;
}

export class UsageService {
  constructor(private readonly repository: UsageRepository) {}

  record(record: Omit<UsageRecord, 'id' | 'createdAt'>): Promise<void> {
    return this.repository.record({
      ...record,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    });
  }

  snapshot(): Promise<UsageRecord[]> {
    return this.repository.snapshot();
  }

  stats(input: UsageStatsInput): Promise<UsageStatsSnapshot> {
    return this.repository.stats(input);
  }

  clearLogs(): Promise<UsageStatsSnapshot> {
    return this.repository.clearLogs();
  }
}
