/**
 * Dev server + production build for the Studio example. Workspace packages resolve
 * from source (like the root vitest config), so no package build is needed.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const packagesDir = fileURLToPath(new URL('../../packages', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@staticflux\/([^/]+)\/(.+)$/, replacement: `${packagesDir}/$1/src/$2.ts` },
      { find: /^@staticflux\/([^/]+)$/, replacement: `${packagesDir}/$1/src/index.ts` },
    ],
  },
  server: { port: 5173, strictPort: false, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // Name feature chunks after their logical chunk id (feature:<name>) for budget reports.
        chunkFileNames: (chunk) => {
          const facade = chunk.facadeModuleId ?? '';
          const feature = /features\/([^/]+)\/index\.ts$/.exec(facade);
          return feature === null ? 'assets/[name]-[hash].js' : `assets/feature-${feature[1]}-[hash].js`;
        },
      },
    },
  },
});
