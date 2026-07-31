'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GatewayStatus } from '@codex-key-switcher/shared';
import { getDesktopApi } from '../lib/desktop-api';

export function useGateway() {
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setGateway(await getDesktopApi().gateway.status());
    } finally {
      setLoading(false);
    }
  }, []);

  const start = useCallback(async () => {
    setLoading(true);
    try {
      const status = await getDesktopApi().gateway.start();
      setGateway(status);
      return status;
    } finally {
      setLoading(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setLoading(true);
    try {
      const status = await getDesktopApi().gateway.stop();
      setGateway(status);
      return status;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    gateway,
    loading,
    refresh,
    start,
    stop,
  };
}
