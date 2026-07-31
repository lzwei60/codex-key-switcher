'use client';

import { App, ConfigProvider, theme } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import type { ReactNode } from 'react';
import { AppPreferencesProvider, useAppPreferences } from '../../lib/app-preferences';

export function AntdProvider({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <AppPreferencesProvider>
      <ThemedAntdProvider>{children}</ThemedAntdProvider>
    </AppPreferencesProvider>
  );
}

function ThemedAntdProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { effectiveTheme, isEnglish } = useAppPreferences();
  const dark = effectiveTheme === 'dark';

  return (
    <ConfigProvider
      locale={isEnglish ? enUS : zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          borderRadius: 6,
          colorPrimary: '#1f7aec',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Layout: {
            bodyBg: dark ? '#0f172a' : '#f6f8fb',
            headerBg: dark ? '#111827' : '#ffffff',
            siderBg: dark ? '#111827' : '#f8fafd',
          },
          Card: {
            borderRadiusLG: 8,
          },
          Button: {
            borderRadius: 6,
          },
          Table: {
            borderColor: '#d9e1ea',
          },
        },
      }}
    >
      <App>{children}</App>
    </ConfigProvider>
  );
}
