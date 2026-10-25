/**
 * D17: Home boots with no document engine and no GPU (C0 IF-28.24). This walks the module graph of Home's entries the
 * way a bundler would — every runtime import, re-export and dynamic `import()`, through workspace packages from
 * source — and fails if it reaches the editor, the render path, Loro (or any CRDT) or GPU code. Type-only imports are
 * erased, so they are skipped. The size budget (`.size-limit.json`, "@instaflow/app/home") holds the bytes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const APP = join(ROOT, 'apps/instaflow');

/** Home's entries: the package export and the dev page. */
const ENTRIES = ['apps/instaflow/src/home/index.ts', 'apps/instaflow/dev/home/main.ts'];

/** What Home must never load (D17): the editor, the render path, Loro / CRDT engines, GPU and Wasm. */
const FORBIDDEN_FILES: readonly RegExp[] = [
  /^apps\/instaflow\/src\/(app|workers|studio|spec|tools|text|elements|repeat|a11y|sequencing|render|lenses|versioning)\//,
  /^apps\/instaflow\/engine\//,
  /^packages\/document\/src\/(loro-crdt|yjs-crdt|crdt-v1-adapter|render-projection|spatial-index)\.ts$/,
  /^packages\/stage\//,
  /^packages\/worker\//,
  /^packages\/wasm\//,
  /^packages\/surface\//,
];
const FORBIDDEN_PACKAGES: readonly string[] = ['loro-crdt', 'yjs', 'rbush', 'harfbuzzjs'];
/** The only app folders Home may reach (everything else in `src/` is Studio's). */
const ALLOWED_APP_FILES = /^apps\/instaflow\/(src\/(home|theme)\/|src\/workspace\/(browser|document-store)\.ts$|src\/library\/(kinds|library-doc|records|errors)\.ts$|dev\/home\/)/;

interface Graph {
  readonly files: ReadonlySet<string>;
  readonly packages: ReadonlySet<string>;
  /** file → the file that first imported it (for the failure message). */
  readonly parent: ReadonlyMap<string, string>;
}

function resolveModule(from: string, specifier: string): { readonly file?: string; readonly pkg?: string } {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts'), base]) if (existsSync(candidate) && candidate.endsWith('.ts')) return { file: candidate };
    throw new Error(`cannot resolve ${specifier} from ${relative(ROOT, from)}`);
  }
  const sf = /^@staticflux\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (sf !== null) {
    const file = join(ROOT, 'packages', sf[1] as string, 'src', `${sf[2] ?? 'index'}.ts`);
    if (!existsSync(file)) throw new Error(`cannot resolve ${specifier}`);
    return { file };
  }
  const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] as string);
  return { pkg };
}

/** Runtime module specifiers of a file (static imports and re-exports that survive emit, and dynamic imports). */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause?.isTypeOnly !== true) out.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) out.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) out.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function walk(entries: readonly string[]): Graph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const parent = new Map<string, string>();
  const queue = entries.map((e) => join(ROOT, e));
  for (const e of queue) files.add(e);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const specifier of runtimeImports(file)) {
      const target = resolveModule(file, specifier);
      if (target.pkg !== undefined) {
        if (!packages.has(target.pkg)) parent.set(`pkg:${target.pkg}`, file);
        packages.add(target.pkg);
      } else if (target.file !== undefined && !files.has(target.file)) {
        files.add(target.file);
        parent.set(target.file, file);
        queue.push(target.file);
      }
    }
  }
  return { files, packages, parent };
}

function chain(graph: Graph, key: string): string {
  const path: string[] = [];
  for (let at: string | undefined = key; at !== undefined; at = graph.parent.get(at)) path.unshift(at.startsWith('pkg:') ? at : relative(ROOT, at));
  return path.join(' → ');
}

describe('Home import graph (D17: no engine, no GPU)', () => {
  const graph = walk(ENTRIES);
  const rel = [...graph.files].map((f) => relative(ROOT, f));

  it('walks a real graph (theme, kit, the Home model and the workspace store)', () => {
    expect(rel).toContain('apps/instaflow/src/home/home-element.ts');
    expect(rel).toContain('apps/instaflow/src/workspace/document-store.ts');
    expect(rel).toContain('packages/kit/src/card.ts');
    expect([...graph.packages]).toContain('lit');
  });

  it('reaches no editor, render, Loro, CRDT, worker, Wasm or GPU module', () => {
    const bad = [...graph.files].filter((f) => FORBIDDEN_FILES.some((p) => p.test(relative(ROOT, f))));
    expect(bad.map((f) => chain(graph, f))).toEqual([]);
    const badPackages = FORBIDDEN_PACKAGES.filter((p) => graph.packages.has(p));
    expect(badPackages.map((p) => chain(graph, `pkg:${p}`))).toEqual([]);
  });

  it('stays inside Home’s own app folders (home, theme, the workspace store, library kinds)', () => {
    const outside = rel.filter((f) => f.startsWith('apps/') && !ALLOWED_APP_FILES.test(f));
    expect(outside.map((f) => chain(graph, join(ROOT, f)))).toEqual([]);
  });

  it('the checker itself catches a forbidden import (Studio’s entry reaches Loro and the editor)', () => {
    const studio = walk(['apps/instaflow/dev/studio/main.ts']);
    const files = [...studio.files].map((f) => relative(ROOT, f));
    expect(files.some((f) => FORBIDDEN_FILES.some((p) => p.test(f)))).toBe(true);
    expect(files).toContain('packages/document/src/loro-crdt.ts');
    expect(existsSync(APP)).toBe(true);
  });
});
