import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import workspace packages from source, so no build is needed to test.
// `@staticflux/<pkg>` → packages/<pkg>/src/index.ts; `@staticflux/<pkg>/<sub>` → packages/<pkg>/src/<sub>.ts
const packagesDir = fileURLToPath(new URL('./packages', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@staticflux\/([^/]+)\/(.+)$/, replacement: `${packagesDir}/$1/src/$2.ts` },
      { find: /^@staticflux\/([^/]+)$/, replacement: `${packagesDir}/$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tooling/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'happy-dom',
  },
});
