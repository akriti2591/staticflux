import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyFailure,
  discoverPackages,
  publishOrder,
  publishPackages,
  type RunResult,
  type Runner,
  type WorkspacePackage,
} from './publish.js';

const pkg = (name: string, internalDeps: string[] = [], extra: Partial<WorkspacePackage> = {}): WorkspacePackage => ({
  name,
  version: '0.1.0',
  dir: `/repo/${name}`,
  private: false,
  internalDeps,
  ...extra,
});

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Scripted runner: `view` answers from `onRegistry`; `publish` pops scripted results per package dir. */
function fakeRunner(onRegistry: Set<string>, publishScript: Record<string, RunResult[]> = {}): Runner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args, cwd) {
      calls.push({ command, args, cwd });
      if (command === 'npm' && args[0] === 'view') {
        const id = args[1] as string;
        return onRegistry.has(id) ? { code: 0, stdout: '0.1.0\n', stderr: '' } : { code: 1, stdout: '', stderr: 'npm error code E404' };
      }
      if (command === 'pnpm') {
        const script = publishScript[cwd];
        return script?.shift() ?? { code: 0, stdout: '+ published', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' }; // git tag
    },
  };
}

const ok: RunResult = { code: 0, stdout: '', stderr: '' };
const rateLimited: RunResult = { code: 1, stdout: '', stderr: 'npm error code E429\n429 Too Many Requests - PUT https://registry.npmjs.org/x' };

function harness() {
  const lines: string[] = [];
  const sleeps: number[] = [];
  return {
    lines,
    sleeps,
    options: {
      root: '/repo',
      log: (l: string) => lines.push(l),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}

describe('publishOrder', () => {
  it('puts dependencies first and is stable by name', () => {
    const order = publishOrder([pkg('@s/ui', ['@s/core', '@s/runtime']), pkg('@s/runtime', ['@s/core']), pkg('@s/core'), pkg('@s/a11y', ['@s/core'])]);
    expect(order.map((p) => p.name)).toEqual(['@s/core', '@s/a11y', '@s/runtime', '@s/ui']);
  });

  it('tolerates cycles', () => {
    const order = publishOrder([pkg('@s/a', ['@s/b']), pkg('@s/b', ['@s/a'])]);
    expect(order.map((p) => p.name).sort()).toEqual(['@s/a', '@s/b']);
  });
});

describe('classifyFailure', () => {
  it('recognises rate limits, conflicts and other errors', () => {
    expect(classifyFailure(rateLimited.stderr)).toBe('rate-limit');
    expect(classifyFailure('Could not publish, as user undefined: rate limited exceeded')).toBe('rate-limit');
    expect(classifyFailure('npm error 403 You cannot publish over the previously published versions: 0.1.0')).toBe('already-exists');
    expect(classifyFailure('npm error code EPUBLISHCONFLICT')).toBe('already-exists');
    expect(classifyFailure('npm error code ENEEDAUTH')).toBe('other');
  });
});

describe('publishPackages', () => {
  it('skips versions already on the registry and publishes the rest one at a time, with a pause between', async () => {
    const h = harness();
    const runner = fakeRunner(new Set(['@s/core@0.1.0']));
    const report = await publishPackages([pkg('@s/core'), pkg('@s/data', ['@s/core']), pkg('@s/ui', ['@s/core'])], { ...h.options, runner, delayMs: 5 });
    expect(report).toMatchObject({ published: 2, skipped: 1, failed: 0 });
    expect(runner.calls.filter((c) => c.command === 'pnpm').map((c) => c.cwd)).toEqual(['/repo/@s/data', '/repo/@s/ui']);
    expect(h.sleeps).toEqual([5]); // pause only between two publishes
    expect(h.lines).toContain('New tag: @s/data@0.1.0');
    expect(runner.calls.filter((c) => c.command === 'git').map((c) => c.args)).toEqual([
      ['tag', '@s/data@0.1.0'],
      ['tag', '@s/ui@0.1.0'],
    ]);
  });

  it('backs off exponentially on 429 and succeeds on a later attempt', async () => {
    const h = harness();
    const runner = fakeRunner(new Set(), { '/repo/@s/data': [rateLimited, rateLimited, ok] });
    const report = await publishPackages([pkg('@s/data')], { ...h.options, runner, initialBackoffMs: 100, maxBackoffMs: 150 });
    expect(report.results[0]).toMatchObject({ outcome: 'published', attempts: 3 });
    expect(h.sleeps).toEqual([100, 150]); // doubled, then capped
  });

  it('gives up after maxAttempts and continues with the next package, reporting failure', async () => {
    const h = harness();
    const runner = fakeRunner(new Set(), { '/repo/@s/a': [rateLimited, rateLimited] });
    const report = await publishPackages([pkg('@s/a'), pkg('@s/b')], { ...h.options, runner, maxAttempts: 2, initialBackoffMs: 1, delayMs: 0 });
    expect(report).toMatchObject({ published: 1, failed: 1 });
    expect(report.results.find((r) => r.name === '@s/a')).toMatchObject({ outcome: 'failed', attempts: 2 });
  });

  it('treats "already published / staged" as skipped, and other errors as immediate failures', async () => {
    const h = harness();
    const runner = fakeRunner(new Set(), {
      '/repo/@s/a': [{ code: 1, stdout: '', stderr: 'You cannot publish over the previously published versions' }],
      '/repo/@s/b': [{ code: 1, stdout: '', stderr: 'npm error code ENEEDAUTH\nneed auth' }],
    });
    const report = await publishPackages([pkg('@s/a'), pkg('@s/b')], { ...h.options, runner, delayMs: 0 });
    expect(report.results.map((r) => r.outcome)).toEqual(['skipped', 'failed']);
    expect(runner.calls.filter((c) => c.command === 'pnpm')).toHaveLength(2); // no retries for non-429
  });

  it('never publishes private packages, and dry-run publishes nothing', async () => {
    const h = harness();
    const runner = fakeRunner(new Set());
    const report = await publishPackages([pkg('@s/app', [], { private: true }), pkg('@s/core')], { ...h.options, runner, dryRun: true });
    expect(report.results).toEqual([{ name: '@s/core', version: '0.1.0', outcome: 'would-publish', attempts: 0 }]);
    expect(runner.calls.some((c) => c.command === 'pnpm' || c.command === 'git')).toBe(false);
  });
});

describe('discoverPackages', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it('reads workspace package.json files and keeps only internal dependencies', () => {
    root = mkdtempSync(join(tmpdir(), 'sf-publish-'));
    const write = (dir: string, json: object): void => {
      mkdirSync(join(root as string, dir), { recursive: true });
      writeFileSync(join(root as string, dir, 'package.json'), JSON.stringify(json));
    };
    write('packages/core', { name: '@s/core', version: '0.1.0', peerDependencies: { mobx: '^7' } });
    write('packages/ui', { name: '@s/ui', version: '0.1.0', dependencies: { '@s/core': 'workspace:*', lit: '3' } });
    write('tooling/cli', { name: '@s/cli', version: '0.1.0', private: true, devDependencies: { '@s/ui': 'workspace:*' } });
    const found = discoverPackages(root).sort((a, b) => a.name.localeCompare(b.name));
    expect(found.map((p) => [p.name, p.private, p.internalDeps])).toEqual([
      ['@s/cli', true, ['@s/ui']],
      ['@s/core', false, []],
      ['@s/ui', false, ['@s/core']],
    ]);
  });
});
