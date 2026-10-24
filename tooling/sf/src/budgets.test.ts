// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeBudgets, applyRatchet, checkName, formatBudgetTable, formatBytes, formatLimitLike, parseBytes, readBudgetConfig, readBudgetResults, type SizeLimitCheck } from './budgets.js';
import { runCli } from './cli.js';
import { captureIo, type TempDir, tempDir } from './test-helpers.js';

describe('byte parsing and formatting', () => {
  it('parses like size-limit (KB = 1000, KiB = 1024)', () => {
    expect(parseBytes('9.5 KB')).toBe(9500);
    expect(parseBytes('7.5 kB')).toBe(7500);
    expect(parseBytes('1 KiB')).toBe(1024);
    expect(parseBytes('2 MB')).toBe(2_000_000);
    expect(parseBytes('300 B')).toBe(300);
    expect(parseBytes('300')).toBe(300);
    expect(parseBytes('lots')).toBeUndefined();
  });

  it('formats a limit in the style of another, rounding up to 0.1 unit', () => {
    expect(formatLimitLike(8020, '9.5 KB')).toBe('8.1 KB');
    expect(formatLimitLike(8000, '9.5 kB')).toBe('8 kB');
    expect(formatLimitLike(2048, '4 KiB')).toBe('2 KiB');
    expect(formatLimitLike(250.2, '300 B')).toBe('251 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(6800)).toBe('6.80 kB');
    expect(formatBytes(1_500_000)).toBe('1.50 MB');
  });

  it('names checks by name, path or index', () => {
    expect(checkName({ name: 'n' }, 0)).toBe('n');
    expect(checkName({ path: 'p.js' }, 0)).toBe('p.js');
    expect(checkName({ path: ['a', 'b'] }, 0)).toBe('a, b');
    expect(checkName({}, 2)).toBe('check #3');
  });
});

const config: SizeLimitCheck[] = [
  { name: 'core full', path: 'packages/core/dist/index.js', limit: '9.5 KB' },
  { name: 'core boot', path: 'packages/core/dist/index.js', import: '{ x }', limit: '7.5 KB' },
  { name: 'router', path: 'packages/router/dist/index.js', limit: '5 KB' },
  { name: 'unmeasured', path: 'x.js', limit: '1 KB' },
  { name: 'timed', path: 'y.js', limit: '500 ms' },
];
const results = [
  { name: 'core full', size: 7000, passed: true },
  { name: 'core boot', size: 7200, passed: true },
  { name: 'router', size: 5600, passed: false },
  { name: 'timed', size: 10 },
];

describe('analyzeBudgets', () => {
  it('classifies rows and proposes ratchets only beyond the threshold', () => {
    const report = analyzeBudgets(config, results);
    expect(report.rows.map((r) => r.status)).toEqual(['ratchet', 'ok', 'over', 'no-result', 'no-limit']);
    expect(report.overCount).toBe(1);
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0]?.proposedLimit).toBe('7.4 KB'); // 7000 × 1.05 = 7350 → 7.4 KB
    expect(report.rows[0]?.usage).toBeCloseTo(7000 / 9500);
  });

  it('respects threshold and headroom options', () => {
    const strict = analyzeBudgets(config, results, { threshold: 0.03, headroom: 0.01 });
    expect(strict.rows[1]?.status).toBe('ratchet'); // 7200 < 7500 × 0.97
    expect(strict.rows[1]?.proposedLimit).toBe('7.3 KB'); // 7272 → 7.3 KB
    expect(analyzeBudgets(config, results, { threshold: 0.3 }).proposals).toEqual([]);
    const noHeadroom = analyzeBudgets(config, results, { headroom: 0 });
    expect(noHeadroom.proposals[0]?.proposedLimit).toBe('7 KB');
  });

  it('never proposes a limit that is not lower', () => {
    // 7200 × 1.05 = 7560 > 7500: the proposal would loosen, so the row stays ok.
    const report = analyzeBudgets(config, results, { threshold: 0.03, headroom: 0.05 });
    expect(report.rows[1]?.status).toBe('ok');
    expect(report.proposals.every((p) => (parseBytes(p.proposedLimit ?? '') ?? Infinity) < (p.limitBytes ?? 0))).toBe(true);
  });
});

describe('applyRatchet', () => {
  it('tightens proposals and never raises a limit', () => {
    const report = analyzeBudgets(config, results);
    const next = applyRatchet(config, report);
    expect(next[0]?.limit).toBe('7.4 KB');
    expect(next[1]).toEqual(config[1]);
    expect(config[0]?.limit).toBe('9.5 KB'); // input untouched
    const forged = { ...report, proposals: [{ ...report.rows[1]!, status: 'ratchet' as const, proposedLimit: '99 KB' }] };
    expect(applyRatchet(config, forged)[1]?.limit).toBe('7.5 KB');
  });
});

describe('formatBudgetTable', () => {
  it('prints a table, ratchet hints and over-budget notes', () => {
    const text = formatBudgetTable(analyzeBudgets(config, results));
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^check\s+limit\s+actual\s+usage\s+status$/);
    expect(text).toMatch(/core full\s+9\.5 KB\s+7\.00 kB\s+74%\s+ratchet → 7\.4 KB/);
    expect(text).toMatch(/router\s+5 KB\s+5\.60 kB\s+112%\s+over/);
    expect(text).toContain('core full: 9.5 KB → 7.4 KB');
    expect(text).toContain('1 budget(s) exceeded');
  });
});

describe('reading files and the CLI', () => {
  let dir: TempDir;
  afterEach(() => dir.dispose());

  it('validates config and results files', () => {
    dir = tempDir();
    dir.write('bad.json', '{');
    dir.write('obj.json', '{}');
    dir.write('res.json', '[{"size": 1}]');
    expect(!readBudgetConfig(join(dir.root, 'missing.json')).ok && 'x').toBe('x');
    const bad = readBudgetConfig(join(dir.root, 'bad.json'));
    expect(!bad.ok && bad.error.code).toBe('SF-TOOL-004');
    expect(readBudgetConfig(join(dir.root, 'obj.json')).ok).toBe(false);
    expect(readBudgetResults(join(dir.root, 'res.json')).ok).toBe(false);
    const missing = readBudgetResults(join(dir.root, 'nope.json'));
    expect(!missing.ok && missing.error.code).toBe('SF-TOOL-003');
  });

  it('sf budgets prints, exits 1 when over, and --write only tightens', async () => {
    dir = tempDir();
    dir.write('.size-limit.json', JSON.stringify(config));
    dir.write('results.json', JSON.stringify(results));
    const io = captureIo(dir.root);
    expect(await runCli(['budgets', '--results', 'results.json'], io)).toBe(1);
    expect(io.out.join('\n')).toContain('ratchet → 7.4 KB');
    expect(JSON.parse(readFileSync(join(dir.root, '.size-limit.json'), 'utf8'))).toEqual(config);

    await runCli(['budgets', '--results', 'results.json', '--write'], captureIo(dir.root));
    const written = JSON.parse(readFileSync(join(dir.root, '.size-limit.json'), 'utf8')) as SizeLimitCheck[];
    expect(written.map((c) => c.limit)).toEqual(['7.4 KB', '7.5 KB', '5 KB', '1 KB', '500 ms']);
    expect(written[1]?.import).toBe('{ x }');
  });

  it('sf budgets --json, --config, --threshold and input errors', async () => {
    dir = tempDir();
    dir.write('limits.json', JSON.stringify(config.slice(0, 2)));
    dir.write('results.json', JSON.stringify(results));
    const io = captureIo(dir.root);
    expect(await runCli(['budgets', '--config', 'limits.json', '--results', 'results.json', '--json', '--threshold', '0.5'], io)).toBe(0);
    const report = JSON.parse(io.out.join('')) as { proposals: unknown[] };
    expect(report.proposals).toEqual([]);
    expect(await runCli(['budgets'], captureIo(dir.root))).toBe(2);
    expect(await runCli(['budgets', '--results', 'results.json'], captureIo(dir.root))).toBe(2); // no .size-limit.json
    expect(await runCli(['budgets', '--config', 'limits.json', '--results', 'nope.json'], captureIo(dir.root))).toBe(2);
    expect(await runCli(['budgets', '--config', 'limits.json', '--results', 'results.json', '--threshold', 'x'], captureIo(dir.root))).toBe(2);
  });
});
