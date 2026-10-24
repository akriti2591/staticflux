// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { budgetsForPackage, GENERATED_END, GENERATED_START, readPackageInfo, renderGeneratedBlock, spliceGeneratedBlock, updateAgentsFiles } from './agents.js';
import { runCli } from './cli.js';
import { captureIo, type TempDir, tempDir } from './test-helpers.js';

let dir: TempDir;
afterEach(() => dir.dispose());

const sizeLimit = [
  { name: '@staticflux/core (full)', path: 'packages/core/dist/index.js', limit: '9.5 KB' },
  { name: '@staticflux/core (boot)', path: './packages/core/dist/index.js', import: '{ createInjector }', limit: '7.5 KB' },
  { name: 'router', path: ['packages/router/dist/index.js'], limit: '5 KB' },
  { name: 'core-ish', path: 'packages/core-extra/dist/index.js', limit: '1 KB' },
];

function repo(): TempDir {
  const d = tempDir();
  d.write('.size-limit.json', JSON.stringify(sizeLimit));
  d.write('packages/core/package.json', JSON.stringify({ name: '@staticflux/core', staticflux: { layer: 'core' }, dependencies: { mobx: '7.1.0' } }));
  d.write('packages/core/AGENTS.md', '# @staticflux/core — AGENTS.md\n\nHand-written intro.\n');
  d.write(
    'packages/router/package.json',
    JSON.stringify({ name: '@staticflux/router', staticflux: { layer: 'framework' }, dependencies: { '@staticflux/core': 'workspace:*', urlpattern: '1.0.0' } }),
  );
  d.write('packages/router/AGENTS.md', `# router\n\nBefore.\n\n${GENERATED_START}\nold stuff\n${GENERATED_END}\n\nAfter (hand-written).\n`);
  d.write('packages/bare/package.json', JSON.stringify({ name: '@staticflux/bare' }));
  d.write('packages/not-a-package/README.md', 'x');
  return d;
}

describe('pure helpers', () => {
  it('reads package info', () => {
    dir = repo();
    const info = readPackageInfo(dir.root, 'packages/router');
    expect(info.ok && info.value).toEqual({ dir: 'packages/router', name: '@staticflux/router', layer: 'framework', dependencies: { '@staticflux/core': 'workspace:*', urlpattern: '1.0.0' } });
    expect(readPackageInfo(dir.root, 'packages/missing').ok).toBe(false);
  });

  it('matches budgets by package directory prefix only', () => {
    const core = budgetsForPackage('packages/core', sizeLimit);
    expect(core.map((b) => b.name)).toEqual(['@staticflux/core (full)', '@staticflux/core (boot)']);
    expect(core[1]?.target).toContain('import `{ createInjector }`');
    expect(budgetsForPackage('packages/router', sizeLimit)).toHaveLength(1);
  });

  it('renders budgets, layer and dependencies', () => {
    const block = renderGeneratedBlock({ dir: 'packages/router', name: '@staticflux/router', layer: 'framework', dependencies: { urlpattern: '1.0.0', '@staticflux/core': 'workspace:*' } }, sizeLimit);
    expect(block.startsWith(GENERATED_START)).toBe(true);
    expect(block.endsWith(GENERATED_END)).toBe(true);
    expect(block).toContain('## Budgets');
    expect(block).toContain('| router | 5 KB | packages/router/dist/index.js |');
    expect(block).toContain('**Layer:** framework');
    expect(block).toContain('- Internal: `@staticflux/core`');
    expect(block).toContain('- External: `urlpattern` (1.0.0)');
  });

  it('renders the empty cases', () => {
    const block = renderGeneratedBlock({ dir: 'packages/bare', name: 'bare', layer: undefined, dependencies: {} }, []);
    expect(block).toContain('No size budget declared');
    expect(block).toContain('not declared');
    expect(block).toContain('None. This package may not import any other package.');
  });

  it('splices between markers or appends them', () => {
    const block = `${GENERATED_START}\nNEW\n${GENERATED_END}`;
    expect(spliceGeneratedBlock(`a\n${GENERATED_START}\nold\n${GENERATED_END}\nb`, block)).toBe(`a\n${block}\nb`);
    expect(spliceGeneratedBlock('# T\n\ntext\n\n\n', block)).toBe(`# T\n\ntext\n\n${block}\n`);
    expect(spliceGeneratedBlock('', block)).toBe(`${block}\n`);
    // A lone end marker before the start marker is not a valid block → append.
    expect(spliceGeneratedBlock(`${GENERATED_END}\nx`, block).endsWith(`${block}\n`)).toBe(true);
  });
});

describe('updateAgentsFiles', () => {
  it('updates, appends and creates; preserves hand-written text; is idempotent', () => {
    dir = repo();
    const first = updateAgentsFiles({ root: dir.root });
    expect(first.errors).toEqual([]);
    expect(first.updates).toEqual([
      { file: 'packages/bare/AGENTS.md', status: 'created' },
      { file: 'packages/core/AGENTS.md', status: 'updated' },
      { file: 'packages/router/AGENTS.md', status: 'updated' },
    ]);
    const core = readFileSync(join(dir.root, 'packages/core/AGENTS.md'), 'utf8');
    expect(core.startsWith('# @staticflux/core — AGENTS.md\n\nHand-written intro.\n\n<!-- sf:generated:start -->')).toBe(true);
    expect(core).toContain('| @staticflux/core (boot) | 7.5 KB |');
    expect(core).not.toContain('core-ish');
    const router = readFileSync(join(dir.root, 'packages/router/AGENTS.md'), 'utf8');
    expect(router).not.toContain('old stuff');
    expect(router).toContain('Before.');
    expect(router).toContain('After (hand-written).');
    expect(router.split(GENERATED_START)).toHaveLength(2);
    expect(readFileSync(join(dir.root, 'packages/bare/AGENTS.md'), 'utf8').startsWith('# @staticflux/bare — AGENTS.md')).toBe(true);
    expect(existsSync(join(dir.root, 'packages/not-a-package/AGENTS.md'))).toBe(false);

    const second = updateAgentsFiles({ root: dir.root });
    expect(second.updates.every((u) => u.status === 'unchanged')).toBe(true);
  });

  it('check mode reports without writing', () => {
    dir = repo();
    const before = readFileSync(join(dir.root, 'packages/core/AGENTS.md'), 'utf8');
    const result = updateAgentsFiles({ root: dir.root, check: true });
    expect(result.updates.filter((u) => u.status !== 'unchanged')).toHaveLength(3);
    expect(readFileSync(join(dir.root, 'packages/core/AGENTS.md'), 'utf8')).toBe(before);
    expect(existsSync(join(dir.root, 'packages/bare/AGENTS.md'))).toBe(false);
  });

  it('supports custom package globs and a missing or invalid .size-limit.json', () => {
    dir = tempDir();
    dir.write('tooling/sf/package.json', JSON.stringify({ name: '@staticflux/sf', staticflux: { layer: 'tooling' } }));
    const result = updateAgentsFiles({ root: dir.root, packages: ['tooling/*'] });
    expect(result.updates).toEqual([{ file: 'tooling/sf/AGENTS.md', status: 'created' }]);
    expect(readFileSync(join(dir.root, 'tooling/sf/AGENTS.md'), 'utf8')).toContain('No size budget declared');
    dir.write('.size-limit.json', '{"not": "array"}');
    expect(updateAgentsFiles({ root: dir.root, packages: ['tooling/*'] }).errors[0]?.code).toBe('SF-TOOL-004');
    dir.write('.size-limit.json', '{');
    expect(updateAgentsFiles({ root: dir.root, packages: ['tooling/*'] }).errors[0]?.code).toBe('SF-TOOL-004');
  });

  it('reports invalid package.json files', () => {
    dir = tempDir();
    dir.write('packages/x/package.json', '"str"');
    expect(updateAgentsFiles({ root: dir.root }).errors[0]?.code).toBe('SF-TOOL-004');
  });
});

describe('sf agents', () => {
  it('writes, then --check passes; --check fails when stale', async () => {
    dir = repo();
    const stale = captureIo(dir.root);
    expect(await runCli(['agents', '--check'], stale)).toBe(1);
    expect(stale.out).toContain('stale: packages/core/AGENTS.md');
    const io = captureIo(dir.root);
    expect(await runCli(['agents'], io)).toBe(0);
    expect(io.out.at(-1)).toBe('3 AGENTS.md file(s) checked, 3 written.');
    expect(await runCli(['agents', '--check'], captureIo(dir.root))).toBe(0);
  });

  it('honours --packages and --size-limit; input errors exit 2', async () => {
    dir = repo();
    dir.write('budgets/limits.json', JSON.stringify([{ name: 'r2', path: 'packages/router/dist/x.js', limit: '2 KB' }]));
    expect(await runCli(['agents', '--packages', 'packages/router', '--size-limit', 'budgets/limits.json'], captureIo(dir.root))).toBe(0);
    expect(readFileSync(join(dir.root, 'packages/router/AGENTS.md'), 'utf8')).toContain('| r2 | 2 KB |');
    dir.write('packages/broken/package.json', '{');
    expect(await runCli(['agents'], captureIo(dir.root))).toBe(2);
  });
});
