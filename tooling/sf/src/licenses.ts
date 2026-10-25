/**
 * `sf licenses` — license allowlist check (IF-2.11) across npm dependencies
 * (`pnpm licenses list --json`), cargo dependencies (`cargo metadata`) and the
 * model-weights registry. Fails on denied (GPL family, non-commercial,
 * watermark, …) or unknown licenses unless a policy exception with a reason
 * covers the package. Denied models fail only when code references them.
 *
 * The policy file (default `license-policy.json`) names what to scan, so the
 * command itself has no app paths built in.
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { InvalidJson, RustToolchainMissing, ToolAborted, ToolStepFailed } from './errors.js';
import { displayPath, expandGlob, listFilesRecursive, readJson, readText } from './files.js';
import { classifyLicense, type LicenseVerdict } from './license-classify.js';
import { classifyModel, findModelReferences, parseModelRegistry, type SourceText } from './model-registry.js';
import type { Runner } from './publish.js';
import { probeRustToolchain } from './rust-toolchain.js';

export const LICENSE_POLICY_FORMAT = 'sf-license-policy/1';
export const DEFAULT_LICENSE_POLICY = 'license-policy.json';

export type Ecosystem = 'npm' | 'cargo' | 'model';

export interface LicenseException {
  readonly ecosystem: 'npm' | 'cargo';
  readonly name: string;
  /** Exact version; omitted = every version. */
  readonly version?: string;
  /** Why this package is acceptable despite its license. Required. */
  readonly reason: string;
}

export interface LicensePolicy {
  readonly format: typeof LICENSE_POLICY_FORMAT;
  /** Check npm dependencies with pnpm. Default true. */
  readonly npm?: boolean;
  /** Cargo workspace directories, relative to the repo root. */
  readonly cargoWorkspaces?: readonly string[];
  /** Model-weights registry JSON, relative to the repo root. */
  readonly modelRegistry?: string;
  /** Globs (dirs or files) scanned for model references. Tests are excluded. */
  readonly modelReferenceRoots?: readonly string[];
  readonly exceptions?: readonly LicenseException[];
}

export interface LicensedPackage {
  readonly ecosystem: 'npm' | 'cargo';
  readonly name: string;
  readonly version: string;
  readonly license: string | undefined;
}

export type FindingStatus = 'ok' | 'excepted' | 'denied' | 'unknown' | 'registered-denied' | 'registered-unknown';

export interface LicenseFinding {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version?: string;
  readonly license: string | undefined;
  readonly verdict: LicenseVerdict;
  readonly status: FindingStatus;
  readonly reason: string;
  /** Models only: files that reference the model. */
  readonly references?: readonly string[];
}

export interface LicenseReport {
  readonly findings: readonly LicenseFinding[];
  /** Parts of the check that did not run, with why (e.g. no Rust toolchain locally). */
  readonly skipped: readonly string[];
  /** Findings with status `denied` or `unknown` — each fails the check. */
  readonly failures: number;
}

const FAILING: ReadonlySet<FindingStatus> = new Set(['denied', 'unknown']);
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|json|html|css|rs|toml|wgsl)$/;
const TEST_FILE = /(\.test\.|\.spec\.|[\\/]__tests__[\\/])/;

export function parseLicensePolicy(json: unknown, source = 'license policy'): Result<LicensePolicy> {
  if (typeof json !== 'object' || json === null) return err(InvalidJson({ message: `${source} must be an object.` }));
  const p = json as Record<string, unknown>;
  const problems: string[] = [];
  if (p['format'] !== LICENSE_POLICY_FORMAT) problems.push(`"format" must be "${LICENSE_POLICY_FORMAT}"`);
  if (p['npm'] !== undefined && typeof p['npm'] !== 'boolean') problems.push('"npm" must be a boolean');
  for (const key of ['cargoWorkspaces', 'modelReferenceRoots'] as const) {
    const v = p[key];
    if (v !== undefined && !(Array.isArray(v) && v.every((s) => typeof s === 'string'))) problems.push(`"${key}" must be an array of strings`);
  }
  if (p['modelRegistry'] !== undefined && typeof p['modelRegistry'] !== 'string') problems.push('"modelRegistry" must be a string');
  const exceptions = p['exceptions'];
  if (exceptions !== undefined) {
    if (!Array.isArray(exceptions)) problems.push('"exceptions" must be an array');
    else
      exceptions.forEach((e: unknown, i) => {
        const x = e as Record<string, unknown> | null;
        if (typeof x !== 'object' || x === null) problems.push(`exceptions[${i}] must be an object`);
        else if (x['ecosystem'] !== 'npm' && x['ecosystem'] !== 'cargo') problems.push(`exceptions[${i}].ecosystem must be "npm" or "cargo"`);
        else if (typeof x['name'] !== 'string' || x['name'].length === 0) problems.push(`exceptions[${i}].name is required`);
        else if (typeof x['reason'] !== 'string' || x['reason'].trim().length === 0) problems.push(`exceptions[${i}] (${x['name']}) needs a "reason"`);
      });
  }
  if (problems.length > 0) return err(InvalidJson({ message: `${source}: ${problems.join('; ')}.` }));
  return ok(p as unknown as LicensePolicy);
}

/** Packages from `pnpm licenses list --json` (`{ [license]: [{ name, versions, license }] }`). */
export function parsePnpmLicenses(json: unknown): Result<LicensedPackage[]> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return err(InvalidJson({ message: '`pnpm licenses list --json` did not print an object.' }));
  const out: LicensedPackage[] = [];
  for (const [group, entries] of Object.entries(json as Record<string, unknown>)) {
    if (!Array.isArray(entries)) return err(InvalidJson({ message: `\`pnpm licenses\` group "${group}" is not an array.` }));
    for (const entry of entries as Record<string, unknown>[]) {
      if (typeof entry?.['name'] !== 'string') continue;
      const versions = Array.isArray(entry['versions']) ? (entry['versions'] as unknown[]).filter((v): v is string => typeof v === 'string') : [];
      const license = typeof entry['license'] === 'string' ? entry['license'] : group;
      for (const version of versions.length > 0 ? versions : ['']) out.push({ ecosystem: 'npm', name: entry['name'], version, license });
    }
  }
  return ok(out);
}

/** Packages from `cargo metadata --format-version 1` (`license`, else `license_file` → unknown). */
export function parseCargoMetadata(json: unknown): Result<LicensedPackage[]> {
  const packages = (json as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(packages)) return err(InvalidJson({ message: '`cargo metadata` output has no "packages" array.' }));
  const out: LicensedPackage[] = [];
  for (const p of packages as Record<string, unknown>[]) {
    if (typeof p?.['name'] !== 'string' || typeof p['version'] !== 'string') continue;
    const licenseFile = typeof p['license_file'] === 'string' ? `SEE LICENSE IN ${p['license_file']}` : undefined;
    out.push({ ecosystem: 'cargo', name: p['name'], version: p['version'], license: typeof p['license'] === 'string' ? p['license'] : licenseFile });
  }
  return ok(out);
}

function findException(pkg: LicensedPackage, exceptions: readonly LicenseException[]): LicenseException | undefined {
  return exceptions.find((e) => e.ecosystem === pkg.ecosystem && e.name === pkg.name && (e.version === undefined || e.version === pkg.version));
}

/** Classify packages; exceptions only cover packages that are not already allowed. Duplicates (same name@version) collapse. */
export function evaluatePackages(packages: readonly LicensedPackage[], exceptions: readonly LicenseException[] = []): LicenseFinding[] {
  const seen = new Set<string>();
  const findings: LicenseFinding[] = [];
  for (const pkg of packages) {
    const key = `${pkg.ecosystem}:${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = classifyLicense(pkg.license);
    const exception = c.verdict === 'allowed' ? undefined : findException(pkg, exceptions);
    const status: FindingStatus = c.verdict === 'allowed' ? 'ok' : exception !== undefined ? 'excepted' : c.verdict;
    findings.push({
      ecosystem: pkg.ecosystem,
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      verdict: c.verdict,
      status,
      reason: exception === undefined ? c.reason : `${c.reason}; exception: ${exception.reason}`,
    });
  }
  return findings;
}

/** Collect scannable source files under the given roots (globs, dirs or files), tests excluded. */
export function collectReferenceSources(roots: readonly string[], cwd: string, exclude: readonly string[] = []): SourceText[] {
  const excluded = new Set(exclude.map((p) => resolve(cwd, p)));
  const files = new Set<string>();
  for (const root of roots) {
    for (const match of expandGlob(root, cwd)) {
      const isDir = statSync(match).isDirectory();
      for (const file of isDir ? listFilesRecursive(match) : [match]) {
        if (SOURCE_EXTENSIONS.test(file) && !TEST_FILE.test(file) && !excluded.has(file) && !/[\\/]target[\\/]/.test(file)) files.add(file);
      }
    }
  }
  const sources: SourceText[] = [];
  for (const file of [...files].sort()) {
    const text = readText(file);
    if (text.ok) sources.push({ path: displayPath(file, cwd), text: text.value });
  }
  return sources;
}

export interface CheckLicensesOptions {
  readonly root: string;
  readonly policy: LicensePolicy;
  /** Absolute path of the policy file (for messages and to resolve nothing else). */
  readonly policyPath?: string;
  readonly runner: Runner;
  /** Fail instead of skipping when cargo is missing (`SF_REQUIRE_RUST=1`). */
  readonly requireRust?: boolean;
  readonly signal?: AbortSignal;
  readonly exists?: (path: string) => boolean;
}

function stepFailed(command: string, cwd: string, output: string): SfError {
  const tail = output.trim().split('\n').slice(-5).join('\n');
  return ToolStepFailed({ message: `\`${command}\` failed in ${cwd}:\n${tail}`, details: { command, cwd } });
}

export async function checkLicenses(options: CheckLicensesOptions): Promise<Result<LicenseReport>> {
  const { root, policy, runner } = options;
  const exists = options.exists ?? existsSync;
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const aborted = (): boolean => options.signal?.aborted === true;
  const findings: LicenseFinding[] = [];
  const skipped: string[] = [];
  const exceptions = policy.exceptions ?? [];

  if (policy.npm !== false) {
    const run = await runner.run('pnpm', ['licenses', 'list', '--json'], root, signal);
    if (aborted()) return err(ToolAborted());
    if (run.code !== 0) return err(stepFailed('pnpm licenses list --json', root, `${run.stderr}\n${run.stdout}`));
    const text = run.stdout.trim();
    // pnpm prints a plain sentence instead of `{}` when there is nothing to list.
    let json: unknown = {};
    if (text.startsWith('{')) {
      try {
        json = JSON.parse(text);
      } catch (cause) {
        return err(InvalidJson({ message: '`pnpm licenses list --json` printed invalid JSON.', cause }));
      }
    }
    const npm = parsePnpmLicenses(json);
    if (!npm.ok) return npm;
    findings.push(...evaluatePackages(npm.value, exceptions));
  }

  for (const workspace of policy.cargoWorkspaces ?? []) {
    const dir = resolve(root, workspace);
    if (!exists(join(dir, 'Cargo.toml'))) return err(InvalidJson({ message: `cargoWorkspaces: ${workspace} has no Cargo.toml.` }));
    const probe = await probeRustToolchain(runner, dir, { wasmTarget: false, exists, ...signal });
    if (aborted()) return err(ToolAborted());
    if (!probe.ok) {
      if (options.requireRust === true) return err(RustToolchainMissing({ message: `Cannot check cargo licenses in ${workspace}: ${probe.missing}.` }));
      skipped.push(`cargo licenses in ${workspace}: ${probe.missing}`);
      continue;
    }
    const args = ['metadata', '--format-version', '1', ...(options.requireRust === true ? ['--locked'] : [])];
    const run = await runner.run('cargo', args, dir, signal);
    if (aborted()) return err(ToolAborted());
    if (run.code !== 0) return err(stepFailed(`cargo ${args.join(' ')}`, dir, run.stderr));
    let json: unknown;
    try {
      json = JSON.parse(run.stdout);
    } catch (cause) {
      return err(InvalidJson({ message: '`cargo metadata` printed invalid JSON.', cause }));
    }
    const cargo = parseCargoMetadata(json);
    if (!cargo.ok) return cargo;
    findings.push(...evaluatePackages(cargo.value, exceptions));
  }

  if (policy.modelRegistry !== undefined) {
    const registryPath = resolve(root, policy.modelRegistry);
    const json = readJson(registryPath);
    if (!json.ok) return json;
    const registry = parseModelRegistry(json.value, policy.modelRegistry);
    if (!registry.ok) return registry;
    const sources = collectReferenceSources(policy.modelReferenceRoots ?? [], root, [registryPath, ...(options.policyPath === undefined ? [] : [options.policyPath])]);
    const refs = findModelReferences(registry.value.models, sources);
    for (const model of registry.value.models) {
      const c = classifyModel(model);
      const references = refs.get(model.id) ?? [];
      const used = references.length > 0;
      const status: FindingStatus = c.verdict === 'allowed' ? 'ok' : used ? c.verdict : c.verdict === 'denied' ? 'registered-denied' : 'registered-unknown';
      findings.push({ ecosystem: 'model', name: model.id, license: model.license, verdict: c.verdict, status, reason: c.reason, references });
    }
  }

  return ok({ findings, skipped, failures: findings.filter((f) => FAILING.has(f.status)).length });
}

export function formatLicenseText(report: LicenseReport): string {
  const lines: string[] = [];
  const label = (f: LicenseFinding): string => `${f.ecosystem} ${f.name}${f.version === undefined || f.version === '' ? '' : `@${f.version}`}`;
  const failing = report.findings.filter((f) => FAILING.has(f.status));
  for (const f of failing) {
    const where = f.references !== undefined && f.references.length > 0 ? ` — referenced in ${f.references.join(', ')}` : '';
    lines.push(`${f.status.toUpperCase().padEnd(8)} ${label(f)} (${f.license ?? 'no license'}): ${f.reason}${where}`);
  }
  for (const f of report.findings.filter((x) => x.status === 'excepted')) lines.push(`excepted ${label(f)} (${f.license ?? 'no license'}): ${f.reason}`);
  for (const f of report.findings.filter((x) => x.status === 'registered-denied' || x.status === 'registered-unknown')) {
    lines.push(`model ${f.name} is registered as ${f.verdict} (${f.reason}); not referenced, so it passes. Never load it.`);
  }
  for (const s of report.skipped) lines.push(`warning: skipped ${s}. Set SF_REQUIRE_RUST=1 to make this an error (CI does).`);
  const count = (eco: Ecosystem): number => report.findings.filter((f) => f.ecosystem === eco).length;
  lines.push(`${report.findings.length} checked (npm ${count('npm')}, cargo ${count('cargo')}, models ${count('model')}): ${report.failures} failing.`);
  if (report.failures > 0) {
    lines.push(
      'Replace denied dependencies (GPL/AGPL/LGPL, non-commercial, watermark). For an unknown license, read it and, if it is acceptable, add an exception with a reason to the license policy.',
    );
  }
  return lines.join('\n');
}
