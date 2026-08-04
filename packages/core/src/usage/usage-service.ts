import type { UsageRecord, UsageSettings, UsageStatsInput, UsageStatsSnapshot } from '@codex-key-switcher/shared';

export interface UsageRepository {
  record(record: UsageRecord): Promise<void>;
  stats(input: UsageStatsInput): Promise<UsageStatsSnapshot>;
  clearLogs(): Promise<UsageStatsSnapshot>;
  configure?(settings: UsageSettings): Promise<void>;
  flush?(): Promise<void>;
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

  stats(input: UsageStatsInput): Promise<UsageStatsSnapshot> {
    return this.repository.stats(input);
  }

  clearLogs(): Promise<UsageStatsSnapshot> {
    return this.repository.clearLogs();
  }

  configure(settings: UsageSettings): Promise<void> {
    return this.repository.configure?.(settings) ?? Promise.resolve();
  }

  flush(): Promise<void> {
    return this.repository.flush?.() ?? Promise.resolve();
  }
}
