import path from 'node:path';

export function desktopPaths(userData: string, home: string) {
  if (!path.isAbsolute(userData) || !path.isAbsolute(home)) {
    throw new Error('桌面应用的数据目录和用户目录必须是绝对路径。');
  }
  return {
    userData,
    home,
    settings: path.join(userData, 'settings.json'),
    providers: path.join(userData, 'providers.json'),
    credentials: path.join(userData, 'api-keys.json'),
    usage: path.join(userData, 'usage.sqlite'),
    codex: path.join(home, '.codex'),
  };
}
