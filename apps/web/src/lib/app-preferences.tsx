'use client';

import type { AppLanguage, AppPreferences, AppTheme } from '@codex-key-switcher/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getDesktopApi } from './desktop-api';

interface AppPreferencesContextValue {
  preferences: AppPreferences;
  effectiveTheme: Exclude<AppTheme, 'system'>;
  isEnglish: boolean;
  setPreferences(input: AppPreferences): Promise<AppPreferences>;
  text(zh: string, en: string): string;
}

const defaultPreferences: AppPreferences = {
  language: 'zh-Hans',
  theme: 'system',
};

const AppPreferencesContext = createContext<AppPreferencesContextValue | null>(null);

export function AppPreferencesProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [preferences, setLocalPreferences] = useState<AppPreferences>(defaultPreferences);
  const [systemTheme, setSystemTheme] = useState<Exclude<AppTheme, 'system'>>('light');

  useEffect(() => {
    let mounted = true;
    getDesktopApi().app.preferences()
      .then((storedPreferences) => {
        if (mounted) setLocalPreferences(normalizePreferences(storedPreferences));
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemTheme(media.matches ? 'dark' : 'light');
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const effectiveTheme = preferences.theme === 'system' ? systemTheme : preferences.theme;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = preferences.language === 'en' ? 'en' : 'zh-CN';
    document.documentElement.dataset.theme = effectiveTheme;
  }, [effectiveTheme, preferences.language]);

  const setPreferences = useCallback(async (input: AppPreferences) => {
    const saved = normalizePreferences(await getDesktopApi().app.savePreferences(normalizePreferences(input)));
    setLocalPreferences(saved);
    return saved;
  }, []);

  const value = useMemo<AppPreferencesContextValue>(() => ({
    preferences,
    effectiveTheme,
    isEnglish: preferences.language === 'en',
    setPreferences,
    text: (zh, en) => preferences.language === 'en' ? en : zh,
  }), [effectiveTheme, preferences, setPreferences]);

  return (
    <AppPreferencesContext.Provider value={value}>
      {children}
    </AppPreferencesContext.Provider>
  );
}

export function useAppPreferences() {
  const context = useContext(AppPreferencesContext);
  if (!context) throw new Error('useAppPreferences must be used inside AppPreferencesProvider');
  return context;
}

function normalizePreferences(input: AppPreferences): AppPreferences {
  return {
    language: normalizeLanguage(input.language),
    theme: normalizeTheme(input.theme),
  };
}

function normalizeLanguage(value: AppLanguage): AppLanguage {
  return value === 'en' ? 'en' : 'zh-Hans';
}

function normalizeTheme(value: AppTheme): AppTheme {
  if (value === 'light' || value === 'dark' || value === 'system') return value;
  return 'system';
}
