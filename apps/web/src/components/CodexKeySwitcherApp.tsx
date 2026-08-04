'use client';

import { useState } from 'react';
import { AppShell } from './layout/AppShell';
import { AboutPage } from './pages/AboutPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { ProviderListPage } from './pages/ProviderListPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatsPage } from './pages/StatsPage';
import { useGateway } from '../hooks/useGateway';
import { useProviders } from '../hooks/useProviders';
import { useUsage } from '../hooks/useUsage';
import type { PageKey, SettingsTabKey } from '../types/navigation';

export function CodexKeySwitcherApp() {
  const [page, setPage] = useState<PageKey>('providers');
  const [settingsTab, setSettingsTab] = useState<SettingsTabKey>('general');
  const providers = useProviders();
  const gateway = useGateway();

  return (
    <AppShell
      activePage={page}
      gateway={gateway.gateway}
      onNavigate={setPage}
    >
      {page === 'providers' ? (
        <ProviderListPage
          gateway={gateway.gateway}
          gatewayLoading={gateway.loading}
          loading={providers.loading}
          onDelete={providers.deleteProvider}
          onOpenSettings={() => setPage('settings')}
          onRefresh={providers.refresh}
          onRefreshGateway={gateway.refresh}
          onSave={providers.saveProvider}
          onStartGateway={gateway.start}
          onSetCurrent={providers.setCurrentProvider}
          onStopGateway={gateway.stop}
          onExport={providers.exportProviders}
          onImport={providers.importProviders}
          providers={providers.providers}
        />
      ) : null}
      {page === 'settings' ? (
        <SettingsPage activeTab={settingsTab} onTabChange={setSettingsTab} />
      ) : null}
      {page === 'stats' ? (
        <StatsPageContainer />
      ) : null}
      {page === 'diagnostics' ? <DiagnosticsPage /> : null}
      {page === 'about' ? <AboutPage /> : null}
    </AppShell>
  );
}

function StatsPageContainer() {
  const usage = useUsage();
  return (
    <StatsPage
      loading={usage.loading}
      onClearLogs={usage.clearLogs}
      onLogPageChange={usage.changeLogPage}
      onRefresh={usage.refresh}
      stats={usage.stats}
    />
  );
}
