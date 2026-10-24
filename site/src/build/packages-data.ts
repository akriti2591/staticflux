/**
 * The package reference is generated at build time from the repository itself, so it can
 * never drift from the code: name/description/layer come from each `package.json`
 * (`staticflux.layer`), purpose and public API from its `AGENTS.md`, and enforced size
 * budgets from `.size-limit.json`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Layer = 'core' | 'runtime' | 'vertical' | 'ui' | 'shell' | 'tooling' | 'app';

export interface PackageInfo {
  /** Directory name, e.g. `core`. */
  readonly dir: string;
  /** `packages` or `tooling`. */
  readonly group: 'packages' | 'tooling';
  readonly name: string;
  readonly description: string;
  readonly layer: Layer;
  /** First paragraph of `## Purpose` in AGENTS.md (markdown-ish). */
  readonly purpose: string;
  /** The `**Budget:**` line of AGENTS.md (markdown-ish), if any. */
  readonly budgetNote: string | undefined;
  /** Files listed under `## Public API`, each with the first identifiers it documents. */
  readonly api: readonly { readonly file: string; readonly names: readonly string[] }[];
  /** Enforced `.size-limit.json` checks for this package. */
  readonly budgets: readonly { readonly name: string; readonly limit: string }[];
  readonly internalDeps: readonly string[];
}

interface SizeLimitEntry {
  readonly name: string;
  readonly path: string;
  readonly limit: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return '';
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line) || line.startsWith('<!--')) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function firstParagraph(text: string): string {
  const para: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (para.length > 0) break;
      continue;
    }
    if (line.startsWith('>') || line.startsWith('#')) continue;
    para.push(line.trim());
  }
  return para.join(' ');
}

/** `- \`file.ts\` — \`a\`, \`b(...)\` …` bullets → file + first identifiers. */
function parseApi(text: string, exported: ReadonlySet<string>): PackageInfo['api'] {
  const entries: { file: string; names: string[] }[] = [];
  let current: { file: string; names: string[] } | undefined;
  for (const line of text.split('\n')) {
    const bullet = /^- (?:SW side.*|Page side.*)?`([^`]+\.ts)`[^—–-]*[—–-]\s*(.*)$/.exec(line) ?? /^- `([^`]+\.ts)`(?:\s*\/\s*`[^`]+`)*\s*(?:\([^)]*\))?\s*[—–-]\s*(.*)$/.exec(line);
    if (bullet !== null) {
      current = { file: bullet[1] ?? '', names: [] };
      entries.push(current);
      collectNames(bullet[2] ?? '', current.names);
      continue;
    }
    if (current !== undefined && /^\s+\S/.test(line)) collectNames(line, current.names);
    else if (!line.startsWith('- ')) current = undefined;
  }
  return entries
    .map((e) => ({ file: e.file, names: e.names.filter((n) => exported.has(n)).slice(0, 6) }))
    .filter((e) => e.names.length > 0);
}

/** Every top-level name exported by the package's source files (tests excluded). */
function exportedNames(srcDir: string): ReadonlySet<string> {
  const names = new Set<string>();
  if (!existsSync(srcDir)) return names;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const source = readFileSync(path, 'utf8');
        for (const m of source.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:const|function|class|interface|type|enum|let)\s+([A-Za-z_$][\w$]*)/gm)) {
          if (m[1] !== undefined) names.add(m[1]);
        }
      }
    }
  };
  walk(srcDir);
  return names;
}

function collectNames(text: string, into: string[]): void {
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const raw = (match[1] ?? '').trim();
    const name = /^[A-Za-z_$][\w$]*/.exec(raw)?.[0];
    if (name === undefined || name.length < 3) continue;
    if (/^(SF|sf)$/.test(name) || /^SF-/.test(raw)) continue;
    if (['true', 'false', 'null', 'undefined', 'string', 'number', 'boolean'].includes(name)) continue;
    if (!into.includes(name)) into.push(name);
  }
}

export function loadPackages(repoRoot: string): readonly PackageInfo[] {
  const sizeLimit = readJson<readonly SizeLimitEntry[]>(join(repoRoot, '.size-limit.json'));
  const result: PackageInfo[] = [];
  for (const group of ['packages', 'tooling'] as const) {
    const base = join(repoRoot, group);
    for (const dir of readdirSync(base).sort()) {
      const pkgPath = join(base, dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson<{
        name: string;
        description?: string;
        staticflux?: { layer?: Layer };
        dependencies?: Record<string, string>;
      }>(pkgPath);
      const agentsPath = join(base, dir, 'AGENTS.md');
      const agents = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
      const budgetLine = /^\*\*Budget[^*]*:\*\*\s*(.*)$/m.exec(agents)?.[1];
      result.push({
        dir,
        group,
        name: pkg.name,
        description: pkg.description ?? '',
        layer: pkg.staticflux?.layer ?? (group === 'tooling' ? 'tooling' : 'vertical'),
        purpose: firstParagraph(section(agents, 'Purpose')),
        budgetNote: budgetLine?.trim(),
        api: parseApi(section(agents, 'Public API (by file)') || section(agents, 'Public API'), exportedNames(join(base, dir, 'src'))),
        budgets: sizeLimit
          .filter((entry) => entry.path.startsWith(`${group}/${dir}/`))
          .map((entry) => ({ name: entry.name.replace(/^@staticflux\/[\w-]+\s*/, '') || 'full', limit: entry.limit })),
        internalDeps: Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@staticflux/')),
      });
    }
  }
  return result;
}

export const LAYER_ORDER: readonly Layer[] = ['core', 'runtime', 'vertical', 'ui', 'shell', 'tooling'];

export const LAYER_LABELS: Readonly<Record<Layer, string>> = {
  core: 'Core',
  runtime: 'Runtime',
  vertical: 'Verticals',
  ui: 'UI',
  shell: 'Shell',
  tooling: 'Tooling',
  app: 'Apps',
};

export const LAYER_BLURBS: Readonly<Record<Layer, string>> = {
  core: 'The static core: tokens, units, injector, scopes, Result, Tasks, machines, telemetry, reactivity. Depends on nothing internal.',
  runtime: 'The app supervisor, app and feature lifecycles, resource manager and frame scheduler.',
  vertical: 'Independent building blocks — each depends only on core (and occasionally another vertical) and plugs in through ports.',
  ui: 'Lit integration, the surface manager and rich surfaces.',
  shell: 'The app frame — slots, themes, workspaces, command palette — and the devtools built on the telemetry fabric.',
  tooling: 'Build-time and test-time only: the sf CLI, bundler plugins, the testkit. Never shipped to browsers.',
  app: 'Applications composed from the packages.',
};
