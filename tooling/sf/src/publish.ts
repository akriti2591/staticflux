/**
 * `sf publish` — publish every public workspace package whose current version
 * is not on the registry yet, **one at a time**, in dependency order, with a
 * pause between packages and exponential backoff on npm rate limits (HTTP 429).
 *
 * Why not `changeset publish`: it publishes 10 packages in parallel with no
 * throttle, which trips npm's anti-spam limits when many packages are released
 * (especially brand-new ones). Changesets still owns versioning/changelogs.
 *
 * Output is compatible with changesets/action: one `New tag: <name>@<version>`
 * line per published package, and a git tag `<name>@<version>` for each.
 * All process access goes through an injected `Runner` so this is unit-tested.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspacePackage {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly private: boolean;
  /** Names of other workspace packages this one depends on (any dependency field). */
  readonly internalDeps: readonly string[];
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Runner {
  run(command: string, args: readonly string[], cwd: string): Promise<RunResult>;
}

export interface PublishOptions {
  readonly runner: Runner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** Repo root (git tags are created here). */
  readonly root: string;
  /** Pause between two publishes. Default 10 s. */
  readonly delayMs?: number;
  /** Attempts per package when rate-limited. Default 6. */
  readonly maxAttempts?: number;
  /** First backoff after a 429; doubles each time. Default 60 s. */
  readonly initialBackoffMs?: number;
  /** Backoff cap. Default 15 min. */
  readonly maxBackoffMs?: number;
  /** List the plan without publishing or tagging. */
  readonly dryRun?: boolean;
}

export type PublishOutcome = 'published' | 'skipped' | 'failed' | 'would-publish';

export interface PublishResult {
  readonly name: string;
  readonly version: string;
  readonly outcome: PublishOutcome;
  readonly attempts: number;
  readonly reason?: string;
}

export interface PublishReport {
  readonly results: readonly PublishResult[];
  readonly published: number;
  readonly skipped: number;
  readonly failed: number;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** Read every package.json under the given workspace directories (one level deep). */
export function discoverPackages(root: string, directories: readonly string[] = ['packages', 'tooling']): WorkspacePackage[] {
  const raw: { name: string; version: string; dir: string; private: boolean; deps: string[] }[] = [];
  for (const directory of directories) {
    const base = join(root, directory);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(base, entry.name, 'package.json');
      if (!existsSync(file)) continue;
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (typeof json['name'] !== 'string' || typeof json['version'] !== 'string') continue;
      const deps = DEPENDENCY_FIELDS.flatMap((field) => Object.keys((json[field] as Record<string, string> | undefined) ?? {}));
      raw.push({ name: json['name'], version: json['version'], dir: join(base, entry.name), private: json['private'] === true, deps });
    }
  }
  const names = new Set(raw.map((p) => p.name));
  return raw.map((p) => ({
    name: p.name,
    version: p.version,
    dir: p.dir,
    private: p.private,
    internalDeps: [...new Set(p.deps.filter((d) => names.has(d) && d !== p.name))].sort(),
  }));
}

/** Dependencies before dependents; ties broken by name so the order is stable. Cycles fall back to name order. */
export function publishOrder(packages: readonly WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const ordered: WorkspacePackage[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (pkg: WorkspacePackage): void => {
    const s = state.get(pkg.name);
    if (s === 'done' || s === 'visiting') return;
    state.set(pkg.name, 'visiting');
    for (const dep of pkg.internalDeps) {
      const next = byName.get(dep);
      if (next !== undefined) visit(next);
    }
    state.set(pkg.name, 'done');
    ordered.push(pkg);
  };
  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg);
  return ordered;
}

export type FailureKind = 'rate-limit' | 'already-exists' | 'other';

/** Classify npm/pnpm publish output. */
export function classifyFailure(output: string): FailureKind {
  if (/\bE429\b|429 Too Many Requests|rate limit/i.test(output)) return 'rate-limit';
  if (/EPUBLISHCONFLICT|cannot publish over|previously published|\bE409\b/i.test(output)) return 'already-exists';
  return 'other';
}

/** True when `name@version` is already on the registry. Unknown (network error) is treated as "not published" — publishing then reports a conflict if it was. */
export async function isPublished(runner: Runner, pkg: WorkspacePackage): Promise<boolean> {
  const result = await runner.run('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], pkg.dir);
  return result.code === 0 && result.stdout.trim().split(/\s+/).includes(pkg.version);
}

export async function publishPackages(packages: readonly WorkspacePackage[], options: PublishOptions): Promise<PublishReport> {
  const delayMs = options.delayMs ?? 10_000;
  const maxAttempts = options.maxAttempts ?? 6;
  const initialBackoffMs = options.initialBackoffMs ?? 60_000;
  const maxBackoffMs = options.maxBackoffMs ?? 15 * 60_000;
  const { runner, sleep, log } = options;

  const results: PublishResult[] = [];
  let publishedAny = false;
  for (const pkg of publishOrder(packages.filter((p) => !p.private))) {
    const id = `${pkg.name}@${pkg.version}`;
    if (await isPublished(runner, pkg)) {
      log(`skip     ${id} (already on the registry)`);
      results.push({ name: pkg.name, version: pkg.version, outcome: 'skipped', attempts: 0 });
      continue;
    }
    if (options.dryRun === true) {
      log(`would publish ${id}`);
      results.push({ name: pkg.name, version: pkg.version, outcome: 'would-publish', attempts: 0 });
      continue;
    }
    if (publishedAny && delayMs > 0) await sleep(delayMs);

    let attempt = 0;
    let backoff = initialBackoffMs;
    let outcome: PublishResult | undefined;
    while (outcome === undefined) {
      attempt += 1;
      log(`publish  ${id} (attempt ${attempt}/${maxAttempts})`);
      const result = await runner.run('pnpm', ['publish', '--no-git-checks', '--access', 'public'], pkg.dir);
      if (result.code === 0) {
        outcome = { name: pkg.name, version: pkg.version, outcome: 'published', attempts: attempt };
        break;
      }
      const kind = classifyFailure(`${result.stdout}\n${result.stderr}`);
      if (kind === 'already-exists') {
        outcome = { name: pkg.name, version: pkg.version, outcome: 'skipped', attempts: attempt, reason: 'version already exists (published or staged)' };
      } else if (kind === 'rate-limit' && attempt < maxAttempts) {
        log(`rate-limited on ${id}; waiting ${Math.round(backoff / 1000)} s before retrying`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoffMs);
      } else {
        const tail = `${result.stderr || result.stdout}`.trim().split('\n').slice(-3).join(' | ');
        outcome = {
          name: pkg.name,
          version: pkg.version,
          outcome: 'failed',
          attempts: attempt,
          reason: kind === 'rate-limit' ? `still rate-limited after ${attempt} attempts` : tail,
        };
      }
    }
    results.push(outcome);
    if (outcome.outcome === 'published') {
      publishedAny = true;
      // changesets/action reads these lines to create GitHub releases.
      log(`New tag: ${id}`);
      const tag = await runner.run('git', ['tag', id], options.root);
      if (tag.code !== 0 && !/already exists/i.test(tag.stderr)) log(`warning: could not create git tag ${id}: ${tag.stderr.trim()}`);
    } else if (outcome.outcome === 'skipped') {
      log(`skip     ${id} (${outcome.reason ?? 'already published'})`);
    } else {
      log(`FAILED   ${id}: ${outcome.reason ?? 'unknown error'}`);
    }
  }
  return {
    results,
    published: results.filter((r) => r.outcome === 'published').length,
    skipped: results.filter((r) => r.outcome === 'skipped').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
  };
}
