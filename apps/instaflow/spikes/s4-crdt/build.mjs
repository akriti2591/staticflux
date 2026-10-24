// Bundles the browser worker (Loro web glue + Yjs + shared phases) into dist/worker.js.
import { build } from 'esbuild';
await build({ entryPoints: ['browser/worker.js'], bundle: true, format: 'esm', outfile: 'dist/worker.js', target: 'es2022', logLevel: 'warning' });
console.log('built dist/worker.js');
