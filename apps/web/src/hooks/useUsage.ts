'use client';

import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import type { UsageStatsSnapshot } from '@codex-key-switcher/shared';
import { getDesktopApi } from '../lib/desktop-api';
import { useAppPreferences } from '../lib/app-preferences';
import { localizeRuntimeMessage } from '../lib/localize';

export function useUsage() {
  const [stats, setStats] = useState<UsageStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(10);
  const { text } = useAppPreferences();

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
      message.error(error instanceof Error ? text(`读取用量统计失败：${error.message}`, `Failed to read usage stats: ${localizeRuntimeMessage(error.message, text)}`) : text('读取用量统计失败', 'Failed to read usage stats'));
    } finally {
      setLoading(false);
    }
  }, [text]);

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
      message.success(text('全部统计数据已清除。', 'All usage statistics were cleared.'));
    } catch (error) {
      message.error(error instanceof Error ? text(`清除全部统计数据失败：${error.message}`, `Failed to clear usage stats: ${localizeRuntimeMessage(error.message, text)}`) : text('清除全部统计数据失败', 'Failed to clear usage stats'));
    } finally {
      setLoading(false);
    }
  }, [text]);

  useEffect(() => {
    void loadStats(1, 10);
  }, [loadStats]);

  return { stats, loading, refresh, changeLogPage, clearLogs };
}
