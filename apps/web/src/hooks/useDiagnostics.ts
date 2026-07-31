'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DiagnosticsReport } from '@codex-key-switcher/shared';
import { getDesktopApi } from '../lib/desktop-api';

export function useDiagnostics() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await getDesktopApi().diagnostics.read());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { report, loading, refresh, setReport };
}
