// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import {
  checkLicenses,
  collectReferenceSources,
  evaluatePackages,
  formatLicenseText,
  type LicensePolicy,
  parseCargoMetadata,
  parseLicensePolicy,
  parsePnpmLicenses,
} from './licenses.js';
import { captureIo, fakeRunner, type RecordedCall, type TempDir, tempDir } from './test-helpers.js';

const pnpmJson = {
  MIT: [{ name: 'lit', versions: ['3.3.3'], license: 'MIT' }],
  'GPL-3.0': [{ name: 'gpl-thing', versions: ['1.0.0', '2.0.0'], license: 'GPL-3.0' }],
  Unknown: [{ name: 'mystery', versions: [] }],
};

const cargoJson = {
  packages: [
    { name: 'wasm-bindgen', version: '0.2.129', license: 'MIT OR Apache-2.0', source: 'registry+https://github.com/rust-lang/crates.io-index' },
    { name: 'unicode-ident', version: '1.0.0', license: '(MIT OR Apache-2.0) AND Unicode-3.0' },
    { name: 'odd', version: '0.1.0', license: null, license_file: 'LICENSE.txt' },
    { name: 'render', version: '0.0.0', license: 'MIT', source: null },
  ],
};

describe('parsers', () => {
  it('reads pnpm licenses JSON: one package per version, group name as fallback license', () => {
    const r = parsePnpmLicenses(pnpmJson);
    expect(r.ok && r.value).toEqual([
      { ecosystem: 'npm', name: 'lit', version: '3.3.3', license: 'MIT' },
      { ecosystem: 'npm', name: 'gpl-thing', version: '1.0.0', license: 'GPL-3.0' },
      { ecosystem: 'npm', name: 'gpl-thing', version: '2.0.0', license: 'GPL-3.0' },
      { ecosystem: 'npm', name: 'mystery', version: '', license: 'Unknown' },
    ]);
    expect(parsePnpmLicenses([]).ok).toBe(false);
    expect(parsePnpmLicenses({ MIT: 'x' }).ok).toBe(false);
    expect(parsePnpmLicenses({ MIT: [{ versions: ['1'] }] }).ok && true).toBe(true);
  });

  it('reads cargo metadata: license, else license_file as a custom license', () => {
    const r = parseCargoMetadata(cargoJson);
    expect(r.ok && r.value.map((p) => p.license)).toEqual(['MIT OR Apache-2.0', '(MIT OR Apache-2.0) AND Unicode-3.0', 'SEE LICENSE IN LICENSE.txt', 'MIT']);
    expect(parseCargoMetadata({}).ok).toBe(false);
    expect(parseCargoMetadata({ packages: [{ name: 'x' }] }).ok && true).toBe(true);
  });

  it('validates the policy and requires a reason on every exception', () => {
    expect(parseLicensePolicy({ format: 'sf-license-policy/1' }).ok).toBe(true);
    expect(parseLicensePolicy(null).ok).toBe(false);
    const bad = parseLicensePolicy({
      format: 'nope',
      npm: 'yes',
      cargoWorkspaces: [1],
      modelRegistry: 3,
      exceptions: [{ ecosystem: 'npm', name: 'a' }, { ecosystem: 'pip', name: 'b', reason: 'r' }, { ecosystem: 'cargo', reason: 'r' }, null],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) for (const part of ['"format"', '"npm"', '"cargoWorkspaces"', '"modelRegistry"', '(a) needs a "reason"', 'exceptions[1].ecosystem', 'exceptions[2].name', 'exceptions[3] must be an object']) expect(bad.error.message).toContain(part);
    expect(parseLicensePolicy({ format: 'sf-license-policy/1', exceptions: {} }).ok).toBe(false);
  });
});

describe('evaluatePackages', () => {
  it('maps verdicts to statuses, dedupes, and applies exceptions only to non-allowed packages', () => {
    const parsed = parsePnpmLicenses(pnpmJson);
    if (!parsed.ok) throw new Error('fixture must parse');
    const packages = [...parsed.value, { ecosystem: 'npm' as const, name: 'lit', version: '3.3.3', license: 'MIT' }];
    const findings = evaluatePackages(packages, [
      { ecosystem: 'npm', name: 'gpl-thing', version: '2.0.0', reason: 'build-time only, never shipped' },
      { ecosystem: 'npm', name: 'lit', reason: 'unused' },
      { ecosystem: 'cargo', name: 'mystery', reason: 'other ecosystem' },
    ]);
    expect(findings.map((f) => `${f.name}@${f.version}:${f.status}`)).toEqual(['lit@3.3.3:ok', 'gpl-thing@1.0.0:denied', 'gpl-thing@2.0.0:excepted', 'mystery@:unknown']);
    expect(findings[2]?.reason).toContain('exception: build-time only');
    expect(findings[0]?.reason).toBe('MIT');
  });
});

let dirs: TempDir[] = [];
afterEach(() => {
  for (const d of dirs) d.dispose();
  dirs = [];
});
function fixture(): TempDir {
  const d = tempDir();
  dirs.push(d);
  return d;
}

const registry = {
  format: 'sf-model-registry/1',
  models: [
    { id: 'good-model', name: 'Good', sourceUrl: 'https://x', license: 'MIT', licenseText: 'MIT', commercialUse: true },
    { id: 'bria-rmbg-1.4', name: 'RMBG', sourceUrl: 'https://x', license: 'bria-rmbg-1.4', licenseText: 'Non-Commercial Use', commercialUse: false, references: ['RMBG-1.4'] },
    { id: 'custom-model', name: 'Custom', sourceUrl: 'https://x', license: 'LicenseRef-Custom', licenseText: '…', commercialUse: true },
  ],
};

/** A repo with an engine dir, a registry and app sources. */
function repo(appSource = "export const m = 'good-model';"): TempDir {
  const d = fixture();
  d.write('engine/Cargo.toml', '[workspace]\n');
  d.write('models/registry.json', JSON.stringify(registry));
  d.write('apps/x/src/main.ts', appSource);
  d.write('apps/x/src/main.test.ts', "it('denies RMBG-1.4', () => {});");
  return d;
}

const policy: LicensePolicy = {
  format: 'sf-license-policy/1',
  cargoWorkspaces: ['engine'],
  modelRegistry: 'models/registry.json',
  modelReferenceRoots: ['apps/*/src'],
};

function toolRunner(over: { pnpm?: string; cargoMissing?: boolean; metadataCode?: number } = {}): ReturnType<typeof fakeRunner> {
  return fakeRunner((call: RecordedCall) => {
    if (call.command === 'pnpm') return { stdout: over.pnpm ?? JSON.stringify({ MIT: [{ name: 'lit', versions: ['3.3.3'], license: 'MIT' }] }) };
    if (over.cargoMissing === true) return undefined;
    if (call.command === 'cargo' && call.args[0] === '-V') return { stdout: 'cargo 1.97.0' };
    if (call.command === 'rustc') return { stdout: 'rustc 1.97.0' };
    if (call.command === 'cargo' && call.args[0] === 'metadata') return over.metadataCode === undefined ? { stdout: JSON.stringify(cargoJson) } : { code: over.metadataCode, stderr: 'error: lock file out of date' };
    return undefined;
  });
}

describe('checkLicenses', () => {
  it('checks npm, cargo and models; denied models that are not referenced pass', async () => {
    const d = repo();
    const runner = toolRunner();
    const r = await checkLicenses({ root: d.root, policy, runner });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const status = Object.fromEntries(r.value.findings.map((f) => [`${f.ecosystem}:${f.name}`, f.status]));
    expect(status).toMatchObject({
      'npm:lit': 'ok',
      'cargo:wasm-bindgen': 'ok',
      'cargo:unicode-ident': 'ok',
      'cargo:odd': 'unknown',
      'model:good-model': 'ok',
      'model:bria-rmbg-1.4': 'registered-denied',
      'model:custom-model': 'registered-unknown',
    });
    expect(r.value.failures).toBe(1); // cargo:odd
    expect(r.value.findings.find((f) => f.name === 'good-model')?.references).toEqual(['apps/x/src/main.ts']);
    const metadata = runner.calls.find((c) => c.args[0] === 'metadata');
    expect(metadata?.cwd).toBe(join(d.root, 'engine'));
    expect(metadata?.args).not.toContain('--locked');
  });

  it('fails when a denied model is referenced from code (tests do not count)', async () => {
    const d = repo("const url = 'https://huggingface.co/briaai/RMBG-1.4/model.onnx';");
    const r = await checkLicenses({ root: d.root, policy: { ...policy, cargoWorkspaces: [] }, runner: toolRunner() });
    expect(r.ok && r.value.findings.find((f) => f.name === 'bria-rmbg-1.4')).toMatchObject({ status: 'denied', references: ['apps/x/src/main.ts'] });
    expect(r.ok && r.value.failures).toBe(1);
    const text = r.ok ? formatLicenseText(r.value) : '';
    expect(text).toContain('DENIED   model bria-rmbg-1.4');
    expect(text).toContain('referenced in apps/x/src/main.ts');
  });

  it('skips cargo with a warning when Rust is missing, and fails when Rust is required', async () => {
    const d = repo();
    const skipped = await checkLicenses({ root: d.root, policy, runner: toolRunner({ cargoMissing: true }) });
    expect(skipped.ok && skipped.value.skipped[0]).toContain('cargo licenses in engine: cargo is not installed');
    expect(skipped.ok && formatLicenseText(skipped.value)).toContain('warning: skipped cargo licenses');
    const required = await checkLicenses({ root: d.root, policy, runner: toolRunner({ cargoMissing: true }), requireRust: true });
    expect(!required.ok && required.error.code).toBe('SF-TOOL-008');
  });

  it('runs cargo metadata with --locked when Rust is required, and reports step failures', async () => {
    const d = repo();
    const runner = toolRunner();
    await checkLicenses({ root: d.root, policy, runner, requireRust: true });
    expect(runner.calls.find((c) => c.args[0] === 'metadata')?.args).toContain('--locked');
    const failed = await checkLicenses({ root: d.root, policy, runner: toolRunner({ metadataCode: 101 }) });
    expect(!failed.ok && failed.error.code).toBe('SF-TOOL-009');
    expect(!failed.ok && failed.error.message).toContain('lock file out of date');
  });

  it('handles pnpm output edge cases and input errors', async () => {
    const d = repo();
    const none = await checkLicenses({ root: d.root, policy: { format: 'sf-license-policy/1' }, runner: toolRunner({ pnpm: 'No licenses in packages found' }) });
    expect(none.ok && none.value.findings).toEqual([]);
    const badJson = await checkLicenses({ root: d.root, policy: { format: 'sf-license-policy/1' }, runner: toolRunner({ pnpm: '{oops' }) });
    expect(!badJson.ok && badJson.error.code).toBe('SF-TOOL-004');
    const pnpmFails = await checkLicenses({ root: d.root, policy: { format: 'sf-license-policy/1' }, runner: fakeRunner(() => ({ code: 1, stderr: 'ERR_PNPM' })) });
    expect(!pnpmFails.ok && pnpmFails.error.code).toBe('SF-TOOL-009');
    const noCargo = await checkLicenses({ root: d.root, policy: { format: 'sf-license-policy/1', npm: false, cargoWorkspaces: ['nowhere'] }, runner: toolRunner() });
    expect(!noCargo.ok && noCargo.error.message).toContain('nowhere has no Cargo.toml');
    const noRegistry = await checkLicenses({ root: d.root, policy: { format: 'sf-license-policy/1', npm: false, modelRegistry: 'missing.json' }, runner: toolRunner() });
    expect(!noRegistry.ok && noRegistry.error.code).toBe('SF-TOOL-003');
  });

  it('stops with SF-TOOL-011 when aborted', async () => {
    const d = repo();
    const controller = new AbortController();
    controller.abort();
    const r = await checkLicenses({ root: d.root, policy, runner: toolRunner(), signal: controller.signal });
    expect(!r.ok && r.error.code).toBe('SF-TOOL-011');
  });
});

describe('collectReferenceSources', () => {
  it('collects source files under globs and files, skipping tests, excluded paths, target/ and other extensions', () => {
    const d = fixture();
    d.write('apps/a/src/x.ts', 'x');
    d.write('apps/a/src/x.spec.ts', 'x');
    d.write('apps/a/src/__tests__/y.ts', 'y');
    d.write('apps/a/src/img.png', 'p');
    d.write('apps/a/src/skip.json', '{}');
    d.write('engine/crates/r/src/lib.rs', 'r');
    d.write('engine/crates/r/target/out.rs', 'r');
    d.write('one.html', '<p>');
    const sources = collectReferenceSources(['apps/*/src', 'engine/crates', 'one.html', 'missing/*'], d.root, ['apps/a/src/skip.json']);
    expect(sources.map((s) => s.path)).toEqual(['apps/a/src/x.ts', 'engine/crates/r/src/lib.rs', 'one.html']);
  });
});

describe('formatLicenseText', () => {
  it('summarises counts and lists excepted packages', () => {
    const text = formatLicenseText({
      findings: [{ ecosystem: 'npm', name: 'a', version: '1.0.0', license: 'GPL-3.0', verdict: 'denied', status: 'excepted', reason: 'GPL; exception: dev only' }, { ecosystem: 'cargo', name: 'b', version: '1', license: undefined, verdict: 'unknown', status: 'unknown', reason: 'no license declared' }],
      skipped: [],
      failures: 1,
    });
    expect(text).toContain('excepted npm a@1.0.0 (GPL-3.0)');
    expect(text).toContain('UNKNOWN  cargo b@1 (no license)');
    expect(text).toContain('2 checked (npm 1, cargo 1, models 0): 1 failing.');
  });
});

describe('sf licenses (CLI)', () => {
  it('exits 0 when clean, 1 on failures, 2 on a bad policy; honours SF_REQUIRE_RUST', async () => {
    const d = repo();
    d.write('license-policy.json', JSON.stringify({ ...policy, cargoWorkspaces: [] }));
    const io = captureIo(d.root, { runner: toolRunner(), env: {} });
    expect(await runCli(['licenses'], io)).toBe(0);
    expect(io.out.join('\n')).toContain('0 failing');

    d.write('strict.json', JSON.stringify(policy));
    expect(await runCli(['licenses', '--policy', 'strict.json', '--json'], captureIo(d.root, { runner: toolRunner(), env: {} }))).toBe(1);
    const ci = captureIo(d.root, { runner: toolRunner({ cargoMissing: true }), env: { SF_REQUIRE_RUST: '1' } });
    expect(await runCli(['licenses', '--policy', 'strict.json'], ci)).toBe(1);
    expect(ci.errs.join('\n')).toContain('SF-TOOL-008');

    d.write('bad.json', JSON.stringify({ format: 'x' }));
    expect(await runCli(['licenses', '--policy', 'bad.json'], captureIo(d.root, { runner: toolRunner() }))).toBe(2);
    expect(await runCli(['licenses', '--policy', 'none.json'], captureIo(d.root, { runner: toolRunner() }))).toBe(2);
    const pnpmFails = captureIo(d.root, { runner: fakeRunner(() => ({ code: 1 })), env: {} });
    expect(await runCli(['licenses'], pnpmFails)).toBe(2);
  });

  it('the repo policy file is valid', () => {
    const json = JSON.parse(readFileSync(new URL('../../../license-policy.json', import.meta.url), 'utf8')) as unknown;
    expect(parseLicensePolicy(json).ok).toBe(true);
  });
});
