import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopPaths } from './desktop-paths';

describe('desktopPaths', () => {
  it('preserves the Electron profile layout without guessing the Tauri directory', () => {
    const profile = path.resolve('fixtures', 'isolated-profile');
    const home = path.resolve('fixtures', 'isolated-home');
    expect(desktopPaths(profile, home)).toEqual({
      userData: profile,
      home,
      settings: path.join(profile, 'settings.json'),
      providers: path.join(profile, 'providers.json'),
      credentials: path.join(profile, 'api-keys.json'),
      usage: path.join(profile, 'usage.sqlite'),
      codex: path.join(home, '.codex'),
    });
  });

  it('rejects relative platform paths', () => {
    expect(() => desktopPaths('relative', path.resolve('home'))).toThrow('绝对路径');
  });
});
