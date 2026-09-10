import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/*
 * Load the monorepo-root .env before Next boots.
 *
 * Next only reads env files from the directory holding this config (apps/web), so in a workspace
 * layout the repo-root .env is invisible to the web process. Without this the app silently starts
 * with no DATABASE_URL, REDIS_URL or API keys — and the failure mode is quiet and wrong: the Jobs
 * screen reports "Redis is unreachable" while Redis is perfectly healthy, and enqueued crawls
 * never run. Root first, then apps/web/.env may override it for app-specific values.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadEnvFile({ path: resolve(here, '../../.env') });
loadEnvFile({ path: resolve(here, '.env') });

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next compiles them in-place.
  transpilePackages: [
    '@seo/shared',
    '@seo/db',
    '@seo/ai',
    '@seo/crawler',
    '@seo/seo-engine',
    '@seo/integrations',
    '@seo/agents',
    '@seo/queue',
  ],
  serverExternalPackages: ['@prisma/client', 'bullmq', 'ioredis', 'playwright', 'googleapis'],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts', 'date-fns'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
