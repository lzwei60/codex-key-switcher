import type { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: 'export',
  outputFileTracingRoot: path.join(configDir, '../..'),
  assetPrefix: './',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
