'use client';

import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import type { UsageStatsSnapshot } from '@codex-key-switcher/shared';
import { getDesktopApi } from '../lib/desktop-api';

export function useUsage() {
  const [stats, setStats] = useState<UsageStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(10);

  const loadStats = useCallback(async (nextPage: number, nextPageSize: number) => {
    setLoading(true);
    try {
      const snapshot = await getDesktopApi().usage.stats({
        logPage: nextPage,
        logPageSize: nextPageSize,
      });
      setStats(snapshot);
      setLogPage(snapshot.logs.page);
      setLogPageSize(snapshot.logs.pageSize);
    } catch (error) {
      message.error(error instanceof Error ? `读取用量统计失败：${error.message}` : '读取用量统计失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await loadStats(logPage, logPageSize);
  }, [loadStats, logPage, logPageSize]);

  const changeLogPage = useCallback(async (page: number, pageSize: number) => {
    await loadStats(page, pageSize);
  }, [loadStats]);

  const clearLogs = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await getDesktopApi().usage.clearLogs();
      setStats(snapshot);
      setLogPage(snapshot.logs.page);
      setLogPageSize(snapshot.logs.pageSize);
      message.success('全部统计数据已清除。');
    } catch (error) {
      message.error(error instanceof Error ? `清除全部统计数据失败：${error.message}` : '清除全部统计数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStats(1, 10);
  }, [loadStats]);

  return { stats, loading, refresh, changeLogPage, clearLogs };
}
