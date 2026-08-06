import type { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rootPackage from '../../package.json' with { type: 'json' };

const configDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: rootPackage.version,
  },
  output: 'export',
  outputFileTracingRoot: path.join(configDir, '../..'),
  assetPrefix: './',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
