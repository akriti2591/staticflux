// Bundles the browser worker (Loro web glue + Yjs + shared phases) into dist/worker.js.
import { build } from 'esbuild';
for (const e of ['worker', 'mem']) await build({ entryPoints: [`browser/${e}.js`], bundle: true, format: 'esm', outfile: `dist/${e}.js`, target: 'es2022', logLevel: 'warning' });
console.log('built dist/worker.js, dist/mem.js');
