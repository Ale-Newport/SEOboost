import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = ['shared', 'db', 'ai', 'crawler', 'seo-engine', 'integrations', 'agents', 'queue'] as const;

/**
 * Alias every workspace package *and* its subpaths.
 *
 * Subpaths matter: `@seo/shared` is the isomorphic barrel while Node-only modules
 * (`@seo/shared/crypto`, `@seo/shared/hash`) are imported explicitly, so a bare-name-only
 * alias table silently fails to resolve half the graph. Longest-prefix first — Vite matches
 * aliases in order.
 */
const alias = [
  ...PACKAGES.map((name) => ({
    find: new RegExp(`^@seo/${name}/(.*)$`),
    replacement: path.join(root, 'packages', name, 'src', '$1'),
  })),
  ...PACKAGES.map((name) => ({
    find: `@seo/${name}`,
    replacement: path.join(root, 'packages', name, 'src', 'index.ts'),
  })),
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**', 'tests/e2e/**'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/index.ts', '**/*.d.ts'],
    },
  },
  resolve: { alias },
});
