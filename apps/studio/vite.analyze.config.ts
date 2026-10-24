import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
export default mergeConfig(base, defineConfig({
  plugins: [{
    name: 'analyze',
    generateBundle(_o, bundle) {
      const chunks: Record<string, any> = {};
      for (const [f, c] of Object.entries(bundle) as any) {
        if (c.type !== 'chunk') continue;
        chunks[f] = { isEntry: c.isEntry, facade: c.facadeModuleId, imports: c.imports, dyn: c.dynamicImports, gz: gzipSync(c.code).length,
          modules: Object.fromEntries(Object.entries(c.modules).map(([id, m]: any) => [id, { len: m.renderedLength, gz: m.code ? gzipSync(m.code).length : 0 }])) };
      }
      writeFileSync(process.env.OUT!, JSON.stringify(chunks));
    },
  }],
}));
