// Module hooks for worker_threads tests: load the workspace's TypeScript sources
// directly (no build). `@staticflux/<pkg>[/<entry>]` → packages/<pkg>/src/<entry>.ts,
// `./x.js` next to a .ts file → `./x.ts`; .ts files are transpiled with the repo's
// TypeScript (type stripping alone cannot handle parameter properties).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(`${root}package.json`);
const ts = require('typescript');

export async function resolve(specifier, context, next) {
  const pkg = /^@staticflux\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (pkg !== null) {
    return { url: pathToFileURL(`${root}packages/${pkg[1]}/src/${pkg[2] ?? 'index'}.ts`).href, shortCircuit: true };
  }
  if (specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const file = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\.js$/, '.ts');
    if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const fileName = fileURLToPath(url);
  const output = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
      useDefineForClassFields: true,
    },
  });
  return { format: 'module', source: output.outputText, shortCircuit: true };
}
