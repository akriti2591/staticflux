// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunk, type SfManifest } from '@staticflux/loader';
import { describe, expect, it } from 'vitest';
import type { CompilationLike, CompilerLike, SourceLike } from './compilation.js';
import {
  type FederationOptions,
  type MfManifestLike,
  normalizeShared,
  packageVersionResolver,
  parseExpose,
  planFederation,
  remoteEntryUrl,
  remoteUrlOf,
} from './federation.js';
import { staticfluxRspack } from './plugin.js';

const studioManifest: MfManifestLike = {
  name: 'studio',
  metaData: { publicPath: 'auto', remoteEntry: { name: 'remoteEntry.js', path: 'mf', type: 'module' } },
  shared: [
    { name: 'lit', version: '3.3.0', requiredVersion: '^3.2.0', singleton: true },
    { name: 'date-fns', version: '4.1.0', requiredVersion: '^4.0.0' },
  ],
  exposes: [{ name: 'Panel', path: './Panel' }, { name: 'Inspector', path: './Inspector' }],
};

const versions: Record<string, string> = { lit: '3.3.1', mobx: '6.13.0', 'date-fns': '2.30.0' };

const base: FederationOptions = {
  remotes: { studio: 'studio@https://cdn.example/studio/mf-manifest.json', chat: { entry: 'https://chat.example/remoteEntry.js' } },
  shared: { lit: { singleton: true, requiredVersion: '^3.0.0' }, mobx: { singleton: true }, 'date-fns': '^2.0.0' },
  exposes: { 'feature:remote-panel': 'studio/Panel', 'feature:remote-inspector': { remote: 'studio', module: 'Inspector' }, 'feature:chat': 'chat/Chat' },
  manifests: { studio: studioManifest },
  resolveVersion: (name) => versions[name],
};
const declared = new Set(['feature:remote-panel', 'feature:remote-inspector', 'feature:chat']);

const plan = (overrides: Partial<FederationOptions> = {}) => planFederation({ ...base, ...overrides }, declared, '/repo');

describe('remote config parsing', () => {
  it('reads MF remote values and exposed module mappings', () => {
    expect(remoteUrlOf('studio@https://cdn/remoteEntry.js')).toBe('https://cdn/remoteEntry.js');
    expect(remoteUrlOf('@scope/app@https://cdn/remoteEntry.js')).toBe('https://cdn/remoteEntry.js');
    expect(remoteUrlOf('https://cdn/remoteEntry.js')).toBe('https://cdn/remoteEntry.js');
    expect(remoteUrlOf('/mf/remoteEntry.js')).toBe('/mf/remoteEntry.js');
    expect(remoteUrlOf({ external: ['a@https://x/remoteEntry.js'] })).toBe('https://x/remoteEntry.js');
    expect(remoteUrlOf({ external: 'a@https://y/remoteEntry.js' })).toBe('https://y/remoteEntry.js');
    expect(remoteUrlOf({})).toBeUndefined();
    expect(parseExpose('studio/Panel')).toEqual({ remote: 'studio', module: './Panel' });
    expect(parseExpose('@org/studio/ui/Panel')).toEqual({ remote: '@org/studio', module: './ui/Panel' });
    expect(parseExpose({ remote: 'studio', module: './Panel' })).toEqual({ remote: 'studio', module: './Panel' });
    expect(parseExpose('studio')).toBeUndefined();
    expect(parseExpose('studio/')).toBeUndefined();
  });

  it('resolves remoteEntry from an mf-manifest.json URL', () => {
    expect(remoteEntryUrl('s', 'https://cdn/s/mf-manifest.json', studioManifest)).toEqual({ ok: true, value: 'https://cdn/s/mf/remoteEntry.js' });
    const fixed = { metaData: { publicPath: 'https://static.example/s', remoteEntry: { name: 'remoteEntry.js' } } };
    expect(remoteEntryUrl('s', 'https://cdn/s/mf-manifest.json', fixed)).toEqual({ ok: true, value: 'https://static.example/s/remoteEntry.js' });
    expect(remoteEntryUrl('s', 'https://cdn/remoteEntry.js', undefined)).toEqual({ ok: true, value: 'https://cdn/remoteEntry.js' });
    const missing = remoteEntryUrl('s', 'https://cdn/s/mf-manifest.json', undefined);
    expect(!missing.ok && missing.error.code).toBe('SF-RSPACK-007');
  });

  it('normalizes shared config (object, string, array) with resolved versions', () => {
    expect(normalizeShared(['lit'], (n) => versions[n])).toEqual([{ name: 'lit', version: '3.3.1', requiredVersion: undefined, singleton: false }]);
    expect(normalizeShared({ lit: { singleton: true, version: '3.0.0', requiredVersion: false } }, () => '9.9.9')).toEqual([
      { name: 'lit', version: '3.0.0', requiredVersion: undefined, singleton: true },
    ]);
    expect(normalizeShared(undefined, () => undefined)).toEqual([]);
  });

  it('reads installed versions from node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-mf-'));
    try {
      mkdirSync(join(dir, 'node_modules', 'lit'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'lit', 'package.json'), JSON.stringify({ name: 'lit', version: '3.3.1' }));
      mkdirSync(join(dir, 'node_modules', 'odd'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'odd', 'package.json'), JSON.stringify({ name: 'odd' }));
      const resolve = packageVersionResolver(dir);
      expect(resolve('lit')).toBe('3.3.1');
      expect(resolve('odd')).toBeUndefined();
      expect(resolve('missing')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('planFederation', () => {
  it('maps exposed modules to manifest remotes with the singleton ranges the remote needs', () => {
    const r = plan();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.remotes).toEqual({
      'feature:remote-panel': { entry: 'https://cdn.example/studio/mf/remoteEntry.js', module: './Panel', shared: { lit: '^3.2.0' } },
      'feature:remote-inspector': { entry: 'https://cdn.example/studio/mf/remoteEntry.js', module: './Inspector', shared: { lit: '^3.2.0' } },
      'feature:chat': { entry: 'https://chat.example/remoteEntry.js', module: './Chat' },
    });
    // date-fns is not a singleton anywhere: the remote's ^4 falls back to its own copy (no error)
    expect(r.value.shared.find((s) => s.name === 'date-fns')).toMatchObject({ version: '2.30.0', singleton: false });
  });

  const failures: [string, Partial<FederationOptions>, string, RegExp][] = [
    ['host version violates its own requiredVersion', { shared: { lit: { singleton: true, requiredVersion: '^4.0.0' } } }, 'SF-RSPACK-005', /lit@3\.3\.1.*\^4\.0\.0/],
    ['singleton without resolvable version', { shared: { lit: { singleton: true }, zod: { singleton: true } } }, 'SF-RSPACK-005', /"zod" has no resolvable version/],
    ['remote singleton not shared by host', { shared: { mobx: { singleton: true } } }, 'SF-RSPACK-005', /uses lit as a singleton, but the host does not share it/],
    ['remote singleton shared non-singleton by host', { shared: { lit: '^3.0.0' } }, 'SF-RSPACK-005', /does not share it as a singleton/],
    ['remote requires a newer singleton', { resolveVersion: (n) => (n === 'lit' ? '3.1.0' : versions[n]) }, 'SF-RSPACK-005', /requires lit@\^3\.2\.0; host provides 3\.1\.0/],
    ['explicit remoteShared not shared by host', { remoteShared: { chat: { zod: '^3.0.0' } } }, 'SF-RSPACK-005', /requires shared zod@\^3\.0\.0, which the host does not share/],
    ['explicit remoteShared version mismatch', { remoteShared: { chat: { mobx: '^7.0.0' } } }, 'SF-RSPACK-005', /requires mobx@\^7\.0\.0; host provides 6\.13\.0/],
    ['unknown remote', { exposes: { 'feature:chat': 'nope/Chat' } }, 'SF-RSPACK-006', /remote "nope", which is not in ModuleFederationPlugin remotes/],
    ['module not exposed', { exposes: { 'feature:remote-panel': 'studio/Missing' } }, 'SF-RSPACK-006', /does not expose "\.\/Missing"/],
    ['undeclared chunk', { exposes: { 'feature:other': 'chat/Chat' } }, 'SF-RSPACK-006', /"feature:other" is not declared/],
    ['bad mapping', { exposes: { 'feature:chat': 'chat' } }, 'SF-RSPACK-006', /is not "<remote>\/<exposed>"/],
    ['remote without URL', { remotes: { ...base.remotes, chat: {} } }, 'SF-RSPACK-007', /"chat" has no entry URL/],
    ['mf-manifest URL without content', { manifests: {} }, 'SF-RSPACK-007', /no manifest content/],
  ];
  for (const [name, overrides, code, message] of failures) {
    it(`fails clearly: ${name}`, () => {
      const r = plan(overrides);
      expect(!r.ok && r.error.code).toBe(code);
      expect(!r.ok && r.error.message).toMatch(message);
      expect(!r.ok && r.error.fix).toBeTruthy();
    });
  }
});

describe('plugin + federation', () => {
  function run(federation: FederationOptions): { emitted: Map<string, SourceLike>; errors: Error[] } {
    const emitted = new Map<string, SourceLike>();
    const errors: Error[] = [];
    const processAssets: (() => void)[] = [];
    const compilation: CompilationLike = {
      hooks: { processAssets: { tap: (_o, fn) => processAssets.push(() => fn({})) } },
      chunkGroups: [{ name: 'lib.shell', chunks: [{ name: 'lib.shell', files: ['shell.12345678.js'] }] }],
      getAsset: () => undefined,
      emitAsset: (name, source) => emitted.set(name, source),
      errors: { push: (...e) => errors.push(...e) },
      warnings: { push: () => 0 },
    };
    const compiler: CompilerLike = { hooks: { thisCompilation: { tap: (_n, fn) => fn(compilation) } }, context: '/repo' };
    staticfluxRspack({
      chunks: [chunk('lib:shell', { tier: 'critical' }), chunk('feature:remote-panel'), chunk('feature:remote-inspector'), chunk('feature:chat')],
      federation,
    }).apply(compiler);
    for (const fn of processAssets) fn();
    return { emitted, errors };
  }

  it('writes federated chunks as manifest remotes', () => {
    const { emitted, errors } = run(base);
    expect(errors).toEqual([]);
    const manifest = JSON.parse(String(emitted.get('sf-manifest.json')?.source())) as SfManifest;
    expect(manifest.chunks['feature:remote-panel']).toMatchObject({
      files: ['https://cdn.example/studio/mf/remoteEntry.js'],
      remote: { entry: 'https://cdn.example/studio/mf/remoteEntry.js', module: './Panel', shared: { lit: '^3.2.0' } },
    });
    expect(manifest.chunks['lib:shell']?.files).toEqual(['shell.12345678.js']);
  });

  it('fails the compilation on a shared mismatch before emitting anything', () => {
    const { emitted, errors } = run({ ...base, shared: { mobx: { singleton: true } } });
    expect(emitted.size).toBe(0);
    expect(errors[0]?.message).toMatch(/^SF-RSPACK-005: Remote "studio" uses lit as a singleton/);
    expect(errors[0]?.message).toContain('\n  fix: ');
  });
});
