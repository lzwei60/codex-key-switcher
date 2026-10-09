import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { DesktopApi } from '@codex-key-switcher/shared';
import { desktopApiForEnvironment } from './desktop-api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('DesktopApi environment selection', () => {
  it('keeps the Electron preload bridge first', () => {
    const preload = { providers: { list: vi.fn(async () => []) } } as unknown as DesktopApi;
    const environment = { desktopAPI: preload, __TAURI_INTERNALS__: {} } as unknown as Window;
    expect(desktopApiForEnvironment(environment)).toBe(preload);
  });

  it('uses registered Rust commands in Tauri instead of web fallback', async () => {
    const environment = { __TAURI_INTERNALS__: {} } as unknown as Window;
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await desktopApiForEnvironment(environment).providers.list();
    expect(invoke).toHaveBeenCalledWith('providers_list');
  });

  it('keeps standalone browser preview available', async () => {
    expect((await desktopApiForEnvironment().providers.list())[0]?.id).toBe('demo-openai');
  });
});
