import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import workspace packages from source, so no build is needed to test.
const packagesDir = fileURLToPath(new URL('./packages', import.meta.url));
const alias = Object.fromEntries(
  readdirSync(packagesDir).map((name) => [`@staticflux/${name}`, `${packagesDir}/${name}/src/index.ts`]),
);

export default defineConfig({
  resolve: { alias: [{ find: '@staticflux/core/graph', replacement: `${packagesDir}/core/src/graph.ts` }, ...Object.entries(alias).map(([find, replacement]) => ({ find, replacement }))] },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tooling/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'happy-dom',
  },
});
