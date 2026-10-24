// @vitest-environment node
import { metric, token, unit } from '@staticflux/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { checkGraph, formatGraphDot, formatGraphJson, formatGraphText, loadGraphModule, readGraphExports } from './graph.js';
import { captureIo, type TempDir, tempDir } from './test-helpers.js';

const A = token('g/a').type<number>();
const B = token('g/b').type<number>();
const C = token('g/c').type<number>();
const Host = token('host/env').type<number>();
const Items = token('g/items').multi<number>();

const b = unit({ id: 'g/b-unit', provides: B, scope: 'app', create: () => 1 });
const a = unit({ id: 'g/a-unit', provides: A, scope: 'app', critical: true, deps: { required: { b: B }, lazy: { host: Host } }, create: () => 1 });

describe('readGraphExports', () => {
  it('accepts units + external tokens or ids', () => {
    const r = readGraphExports({ units: [a, b], external: [Host, 'other/x'] }, 'm');
    expect(r.ok && r.value.external).toEqual(['host/env', 'other/x']);
  });

  it('accepts a defineModule-shaped `module` export', () => {
    const r = readGraphExports({ module: { id: 'g/mod', units: [a, b], external: [Host] } }, 'm');
    expect(r.ok && r.value.units.length).toBe(2);
    expect(r.ok && r.value.external).toEqual(['host/env']);
  });

  it('rejects missing units, bad units and bad external', () => {
    const none = readGraphExports({ foo: 1 }, 'm');
    expect(!none.ok && none.error.code).toBe('SF-TOOL-002');
    expect(!none.ok && none.error.message).toContain('foo');
    const badUnit = readGraphExports({ units: [a, { id: 'x' }] }, 'm');
    expect(!badUnit.ok && badUnit.error.message).toContain('units[1]');
    const badExternal = readGraphExports({ units: [a], external: 'nope' }, 'm');
    expect(badExternal.ok).toBe(false);
    const badEntry = readGraphExports({ units: [a], external: [42] }, 'm');
    expect(!badEntry.ok && badEntry.error.message).toContain('external[0]');
  });
});

describe('checkGraph', () => {
  it('reports a clean graph with boot order and critical set', () => {
    const result = checkGraph({ units: [a, b], external: ['host/env'] });
    expect(result.errorCount).toBe(0);
    expect(result.report.bootOrder).toEqual(['g/b-unit', 'g/a-unit']);
    expect(result.report.criticalSet).toEqual(['g/a-unit', 'g/b-unit']);
  });

  it('flags missing providers as errors unless external', () => {
    const missing = checkGraph({ units: [a, b], external: [] });
    expect(missing.issues.some((i) => i.code === 'SF-DI-001' && i.severity === 'warning')).toBe(true); // lazy → warning
    const c = unit({ id: 'g/c-unit', provides: C, scope: 'app', deps: { required: { host: Host } }, create: () => 1 });
    const required = checkGraph({ units: [c], external: [] });
    expect(required.errorCount).toBe(1);
    expect(checkGraph({ units: [c], external: [] }, { external: ['host/env'] }).errorCount).toBe(0);
  });

  it('detects cycles, scope violations and sorts by severity', () => {
    const x = unit({ id: 'g/x', provides: A, scope: 'app', deps: { required: { b: B } }, create: () => 1 });
    const y = unit({ id: 'g/y', provides: B, scope: 'feature', deps: { required: { a: A } }, create: () => 1 });
    const result = checkGraph({ units: [x, y], external: [] });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('SF-DI-004');
    expect(codes).toContain('SF-DI-002');
    expect(result.issues[0]?.severity).toBe('error');
    expect(result.errorCount).toBeGreaterThanOrEqual(2);
  });

  it('adds duplicate-provider warnings (not for multi tokens) and unused info', () => {
    const b2 = unit({ id: 'g/b-unit-2', provides: B, scope: 'app', create: () => 2 });
    const i1 = unit({ id: 'g/i1', provides: Items, scope: 'app', create: () => [1] });
    const i2 = unit({ id: 'g/i2', provides: Items, scope: 'app', create: () => [2] });
    const result = checkGraph({ units: [a, b, b2, i1, i2], external: ['host/env'] });
    const dup = result.issues.filter((i) => i.code === 'SF-GRAPH-DUP-PROVIDER');
    expect(dup).toHaveLength(1);
    expect(dup[0]?.units).toEqual(['g/b-unit', 'g/b-unit-2']);
    const unused = result.issues.filter((i) => i.code === 'SF-GRAPH-UNUSED').flatMap((i) => i.units);
    expect(unused).toEqual(expect.arrayContaining(['g/i1', 'g/i2']));
    expect(unused).not.toContain('g/a-unit'); // critical
    expect(unused).not.toContain('g/b-unit'); // depended on
  });

  it('passes fan-out limits and reports metric mismatches (R17.21)', () => {
    const m = metric.counter('g/clicks');
    const reader = unit({ id: 'g/reader', provides: C, scope: 'app', reads: [m], deps: { required: { b: B } }, create: () => 1 });
    const result = checkGraph({ units: [reader, b], external: [] }, { maxFanOut: 0 });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('SF-GRAPH-FANOUT');
    expect(codes).toContain('SF-METRIC-001');
  });
});

describe('formatters', () => {
  const result = checkGraph({ units: [a, b], external: [] });

  it('text report has issues, boot order, critical set and table', () => {
    const text = formatGraphText(result);
    expect(text).toContain('WARNINGS');
    expect(text).toContain('SF-DI-001');
    expect(text).toContain('Boot order');
    expect(text).toMatch(/1\. g\/b-unit/);
    expect(text).toContain('Critical set (2)');
    expect(text).toMatch(/g\/a-unit\s+app\s+0\s+2\s+yes/);
  });

  it('json report is parseable and includes sf issues', () => {
    const json = JSON.parse(formatGraphJson(result)) as { issues: unknown[]; bootOrder: string[]; errorCount: number };
    expect(json.bootOrder).toEqual(['g/b-unit', 'g/a-unit']);
    expect(json.errorCount).toBe(0);
  });

  it('dot output styles critical nodes and edge kinds', () => {
    const c = unit({ id: 'g/c"q', provides: C, scope: 'app', deps: { functional: { a: A } }, create: () => 1 });
    const dot = formatGraphDot(checkGraph({ units: [a, b, c], external: ['host/env'] }));
    expect(dot.startsWith('digraph staticflux {')).toBe(true);
    expect(dot).toContain('"g/a-unit" -> "g/b-unit" [style=solid]');
    expect(dot).toContain('"g/c\\"q" -> "g/a-unit" [style=dotted]');
    expect(dot).toMatch(/"g\/a-unit" \[.*fillcolor="#fde68a"/);
    expect(dot).toMatch(/"g\/b-unit" \[.*fillcolor="#fef3c7"/);
  });

  it('dot output marks error units red', () => {
    const c = unit({ id: 'g/c-unit', provides: C, scope: 'app', deps: { required: { host: Host } }, create: () => 1 });
    expect(formatGraphDot(checkGraph({ units: [c], external: [] }))).toContain('color="#dc2626"');
  });
});

describe('loading entry modules and the CLI', () => {
  let dir: TempDir;
  afterEach(() => dir.dispose());

  const moduleSource = (withMissing: boolean): string => `
const tok = (id) => ({ kind: 'token', id, multi: false });
export const units = [
  { id: 'm/a', provides: tok('m/a'), scope: 'app', critical: true, deps: { required: { b: tok('m/b')${withMissing ? ", c: tok('m/missing')" : ''} } } },
  { id: 'm/b', provides: tok('m/b'), scope: 'app', deps: { lazy: { h: tok('host/x') } } },
];
export const external = ['host/x'];
`;

  it('imports a real module from disk', async () => {
    dir = tempDir({ importable: true });
    dir.write('entry.mjs', moduleSource(false));
    const loaded = await loadGraphModule('entry.mjs', dir.root);
    expect(loaded.ok && loaded.value.units.map((u) => u.id)).toEqual(['m/a', 'm/b']);
  });

  it('reports a missing module as SF-TOOL-001', async () => {
    dir = tempDir({ importable: true });
    const loaded = await loadGraphModule('nope.mjs', dir.root);
    expect(!loaded.ok && loaded.error.code).toBe('SF-TOOL-001');
  });

  it('reports a throwing module as SF-TOOL-001', async () => {
    dir = tempDir({ importable: true });
    dir.write('boom.mjs', "throw new Error('kaboom');");
    const loaded = await loadGraphModule('boom.mjs', dir.root);
    expect(!loaded.ok && loaded.error.message).toContain('kaboom');
  });

  it('sf graph exits 0 on a clean graph and 1 on errors', async () => {
    dir = tempDir({ importable: true });
    dir.write('ok.mjs', moduleSource(false));
    dir.write('bad.mjs', moduleSource(true));
    const io = captureIo(dir.root);
    expect(await runCli(['graph', 'ok.mjs'], io)).toBe(0);
    expect(io.out.join('\n')).toContain('Boot order');
    const bad = captureIo(dir.root);
    expect(await runCli(['graph', 'bad.mjs', '--json'], bad)).toBe(1);
    expect((JSON.parse(bad.out.join('')) as { errorCount: number }).errorCount).toBe(1);
    const dot = captureIo(dir.root);
    await runCli(['graph', 'ok.mjs', '--dot'], dot);
    expect(dot.out.join('')).toContain('digraph');
  });

  it('sf graph honours --external and --max-fan-out', async () => {
    dir = tempDir({ importable: true });
    dir.write('bad.mjs', moduleSource(true));
    const io = captureIo(dir.root);
    expect(await runCli(['graph', 'bad.mjs', '--external', 'm/missing', '--max-fan-out=1', '--json'], io)).toBe(0);
    const json = JSON.parse(io.out.join('')) as { issues: { code: string }[] };
    expect(json.issues.map((i) => i.code)).toContain('SF-GRAPH-FANOUT');
  });

  it('sf graph usage and load errors exit 2', async () => {
    dir = tempDir({ importable: true });
    const io = captureIo(dir.root);
    expect(await runCli(['graph'], io)).toBe(2);
    expect(await runCli(['graph', 'missing.mjs'], io)).toBe(2);
    expect(await runCli(['graph', 'x.mjs', '--max-fan-in', 'abc'], io)).toBe(2);
    expect(io.errs.join('\n')).toContain('SF-TOOL-005');
    expect(io.errs.join('\n')).toContain('fix:');
  });
});
