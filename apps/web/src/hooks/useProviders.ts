'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Provider, ProviderInput } from '@codex-key-switcher/shared';
import { getDesktopApi } from '../lib/desktop-api';

export function useProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProviders(await getDesktopApi().providers.list());
    } finally {
      setLoading(false);
    }
  }, []);

  const saveProvider = useCallback(async (input: ProviderInput) => {
    const provider = await getDesktopApi().providers.save(input);
    await refresh();
    return provider;
  }, [refresh]);

  const deleteProvider = useCallback(async (providerId: string) => {
    await getDesktopApi().providers.delete(providerId);
    await refresh();
  }, [refresh]);

  const setCurrentProvider = useCallback(async (providerId: string) => {
    await getDesktopApi().providers.setCurrent(providerId);
    await refresh();
  }, [refresh]);

  const setSelectedModel = useCallback(async (providerId: string, model: string) => {
    await getDesktopApi().providers.setSelectedModel(providerId, model);
    await refresh();
  }, [refresh]);

  const exportProviders = useCallback(async (includeAPIKeys: boolean) => {
    return getDesktopApi().providers.exportToFile(includeAPIKeys);
  }, []);

  const importProviders = useCallback(async () => {
    const importedCount = await getDesktopApi().providers.importFromFile();
    await refresh();
    return importedCount;
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    providers,
    loading,
    refresh,
    saveProvider,
    deleteProvider,
    setCurrentProvider,
    setSelectedModel,
    exportProviders,
    importProviders,
  };
}
