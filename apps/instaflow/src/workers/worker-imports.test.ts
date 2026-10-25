// @vitest-environment node
// IF-33.17: the worker bundle is DOM-free. lit-html's browser build reads `document` and Lit's element base extends
// `HTMLElement` when they load, so anything the worker imports must not reach Lit, the kit or the UI runtime. Node
// resolves Lit to its server build, so only this static walk of the import graph catches a regression before a
// browser does.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const ENTRY = resolve(here, 'studio.worker.ts');

/** Modules a worker may not load (value imports). */
const FORBIDDEN = [/^lit($|\/)/, /^@lit\/(?!reactive-element\/css-tag\.js$)/, /^@staticflux\/(kit|shell)($|\/)/, /^@staticflux\/ui$/, /^@staticflux\/surface\/a11y-layer/];
/** App files that are main-thread only. */
const MAIN_ONLY = [/\/a11y\/dom\.ts$/, /\/app\/studio-(app|canvas)\.ts$/, /\/tools\/overlay-labels\.ts$/, /-panel\.ts$/, /\/panel\.ts$/];

function resolveSpecifier(from: string, spec: string): string | undefined {
  if (spec.startsWith('.')) {
    const ts = resolve(dirname(from), spec).replace(/\.js$/, '.ts');
    if (existsSync(ts)) return ts;
    const index = ts.replace(/\.ts$/, '/index.ts');
    return existsSync(index) ? index : undefined;
  }
  const m = /^@staticflux\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (m === null) return undefined;
  const file = resolve(repo, 'packages', m[1] as string, 'src', `${m[2] ?? 'index'}.ts`);
  return existsSync(file) ? file : undefined;
}

/** Value imports and re-exports of a module (type-only ones are erased). */
function valueImports(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)([^'";]*?)\s*from\s*['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const clause = (m[1] ?? '').trim();
    const spec = (m[2] ?? m[3]) as string;
    const names = /^\{([^}]*)\}$/.exec(clause)?.[1];
    if (names !== undefined && names.split(',').every((n) => n.trim() === '' || n.trim().startsWith('type '))) continue;
    out.push(spec);
  }
  return out;
}

function walk(entry: string): { readonly files: Set<string>; readonly violations: string[] } {
  const files = new Set<string>();
  const violations: string[] = [];
  const visit = (file: string, chain: readonly string[]): void => {
    if (files.has(file)) return;
    files.add(file);
    const path = [...chain, file.replace(`${repo}/`, '')];
    if (MAIN_ONLY.some((re) => re.test(file))) violations.push(path.join(' → '));
    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      if (FORBIDDEN.some((re) => re.test(spec))) {
        violations.push([...path, spec].join(' → '));
        continue;
      }
      const next = resolveSpecifier(file, spec);
      if (next !== undefined) visit(next, path);
    }
  };
  visit(entry, []);
  return { files, violations };
}

describe("the worker's import graph (IF-33.17)", () => {
  it('reaches the editor and render modules but no Lit, kit, UI runtime or main-thread module', () => {
    const { files, violations } = walk(ENTRY);
    expect(violations).toEqual([]);
    const reached = [...files].map((f) => f.replace(`${repo}/`, ''));
    expect(reached).toEqual(expect.arrayContaining(['apps/instaflow/src/workers/editor-module.ts', 'apps/instaflow/src/app/canvas-tab.ts', 'apps/instaflow/src/app/vello-raster.ts', 'apps/instaflow/src/sequencing/render-module.ts']));
  });

  it('flags a forbidden import (the walk itself works)', () => {
    expect(valueImports("import { html } from 'lit';\nimport type { X } from 'lit';\nimport { type Y } from '@staticflux/kit';\nexport * from './a.js';")).toEqual(['lit', './a.js']);
    expect(FORBIDDEN.some((re) => re.test('@lit/reactive-element/css-tag.js'))).toBe(false);
    expect(FORBIDDEN.some((re) => re.test('@lit/reactive-element'))).toBe(true);
  });
});
