import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tooling/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'happy-dom',
  },
});
