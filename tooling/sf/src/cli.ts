#!/usr/bin/env node
/**
 * `sf` — the StaticFlux CLI (R20.6). Thin argv layer over the command
 * functions; `runCli` is pure enough to test (injected cwd/output/importer).
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SfError, TokenId } from '@staticflux/core';
import { updateAgentsFiles } from './agents.js';
import { analyzeBudgets, applyRatchet, formatBudgetTable, readBudgetConfig, readBudgetResults, writeBudgetConfig } from './budgets.js';
import { collectErrorCatalog, isErrorCatalogCurrent, serializeErrorCatalog, writeErrorCatalog } from './error-catalog.js';
import { UsageError } from './errors.js';
import { formatError, type ModuleImporter, readJson } from './files.js';
import { checkGraph, formatGraphDot, formatGraphJson, formatGraphText, loadGraphModule } from './graph.js';
import { formatLintText, LINT_RULES, type LintConfig, type LintRule, lintPaths } from './lint.js';
import { checkManifest, formatManifestText } from './manifest-check.js';
import { discoverPackages, publishPackages, type Runner } from './publish.js';
import { checkRoutes, formatRoutesJson, formatRoutesText, loadRoutesModule } from './routes.js';
import { spawn } from 'node:child_process';

export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly importer?: ModuleImporter;
}

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

/** Flags that take a value (`--out x` or `--out=x`); every other `--flag` is boolean. */
const VALUE_FLAGS = new Set(['out', 'rules', 'flag-names', 'config', 'results', 'threshold', 'headroom', 'packages', 'size-limit', 'max-fan-out', 'max-fan-in', 'external', 'max-eager-kb', 'max-boot-kb', 'report', 'delay-ms', 'max-attempts', 'backoff-ms', 'max-backoff-ms']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) flags.set(name, arg.slice(eq + 1));
      else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) {
        flags.set(name, argv[i + 1] as string);
        i += 1;
      } else flags.set(name, true);
      continue;
    }
    if (command === undefined) command = arg;
    else positionals.push(arg);
  }
  return { command, positionals, flags };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function listFlag(args: ParsedArgs, name: string): string[] | undefined {
  const value = stringFlag(args, name);
  return value === undefined ? undefined : value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function numberFlag(args: ParsedArgs, name: string): number | undefined | SfError {
  const value = stringFlag(args, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : UsageError({ message: `--${name} expects a number, got "${value}".` });
}

export const HELP = `sf — StaticFlux CLI

Usage: sf <command> [options]

  graph <entry-module>   Check the DI graph of a module exporting \`units\` (+ \`external\`)
      --json | --dot       machine-readable / Graphviz output
      --max-fan-out N      --max-fan-in N      --external a/b,c/d
  errors [modules…]      Write the error catalog (default modules: packages/*/dist/index.js)
      --out FILE           default docs/errors.json
      --check              exit 1 if FILE is stale (no write)
      --strict             exit 1 if a module fails to import
      --json               print the catalog to stdout instead of writing
  lint [paths…]          StaticFlux lint rules (default: packages/*/src, tests excluded)
      --json   --rules a,b   --flag-names flag,readFlag   --include-tests
  budgets                Budget table + ratchet proposals
      --results FILE       output of \`size-limit --json\` (required)
      --config FILE        default .size-limit.json
      --threshold 0.1      --headroom 0.05     --write (apply tightenings only)   --json
  agents                 Regenerate Budgets / Allowed dependencies in packages/*/AGENTS.md
      --packages glob,…    --size-limit FILE   --check (exit 1 if stale, no write)
  routes <entry-module>  Route × profile completeness (R18.7): module exports \`routes\`,
                         \`features\` and \`profiles\` (or \`hostModes\` + \`formFactors\`)
      --json
  manifest <file>        Validate an sf-manifest.json: schema, dangling deps, budgets
                         (chunk budgets on bytes beyond the boot set, from sf-build-report.json
                         next to the manifest)
      --max-eager-kb N     fail when the eager boot cost exceeds N KB   --json
      --max-boot-kb N      fail when a profile's boot JS exceeds N KB (needs the report)
      --report FILE        build report path (default: <manifest dir>/sf-build-report.json)
      --no-report          check the manifest alone (closure overruns are warnings)
  publish                Publish public workspace packages whose version is not on npm yet,
                         one at a time in dependency order (used by the Release workflow)
      --dry-run            list what would be published
      --delay-ms N         pause between packages (default 10000)
      --max-attempts N     attempts per package on HTTP 429 (default 6)
      --backoff-ms N       first rate-limit backoff, doubles each retry (default 60000)
      --max-backoff-ms N   backoff cap (default 900000)
  help

Exit codes: 0 ok · 1 check failed · 2 usage or input error.`;

async function graphCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const entry = args.positionals[0];
  if (entry === undefined) {
    io.stderr(formatError(UsageError({ message: '`sf graph` needs an entry module path.' })));
    return 2;
  }
  const maxFanOut = numberFlag(args, 'max-fan-out');
  const maxFanIn = numberFlag(args, 'max-fan-in');
  for (const n of [maxFanOut, maxFanIn]) {
    if (typeof n === 'object') {
      io.stderr(formatError(n));
      return 2;
    }
  }
  const loaded = await loadGraphModule(entry, io.cwd, io.importer);
  if (!loaded.ok) {
    io.stderr(formatError(loaded.error));
    return 2;
  }
  const result = checkGraph(loaded.value, {
    ...(typeof maxFanOut === 'number' ? { maxFanOut } : {}),
    ...(typeof maxFanIn === 'number' ? { maxFanIn } : {}),
    external: (listFlag(args, 'external') ?? []) as TokenId[],
  });
  if (args.flags.has('dot')) io.stdout(formatGraphDot(result));
  else if (args.flags.has('json')) io.stdout(formatGraphJson(result));
  else io.stdout(formatGraphText(result));
  return result.errorCount > 0 ? 1 : 0;
}

async function errorsCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const result = await collectErrorCatalog({ cwd: io.cwd, modules: args.positionals, ...(io.importer === undefined ? {} : { importer: io.importer }) });
  for (const failure of result.failures) io.stderr(`warning: ${formatError(failure)}`);
  for (const conflict of result.conflicts) io.stderr(formatError(conflict));
  const out = resolve(io.cwd, stringFlag(args, 'out') ?? join('docs', 'errors.json'));
  let code = result.conflicts.length > 0 || (args.flags.has('strict') && result.failures.length > 0) ? 1 : 0;
  if (args.flags.has('json')) {
    io.stdout(serializeErrorCatalog(result.catalog).trimEnd());
  } else if (args.flags.has('check')) {
    if (isErrorCatalogCurrent(out, result.catalog)) io.stdout(`${out} is up to date (${result.catalog.errors.length} codes).`);
    else {
      io.stderr(`${out} is stale; run \`sf errors\` and commit the result.`);
      code = 1;
    }
  } else {
    const changed = writeErrorCatalog(out, result.catalog);
    io.stdout(`${changed ? 'Wrote' : 'Unchanged'} ${out}: ${result.catalog.errors.length} codes from ${result.loaded.length} module(s).`);
  }
  return code;
}

function lintCommand(args: ParsedArgs, io: CliIo): number {
  const config: Partial<{ -readonly [K in keyof LintConfig]: LintConfig[K] }> = {};
  const rules = listFlag(args, 'rules');
  if (rules !== undefined) {
    const unknown = rules.filter((r) => !(LINT_RULES as readonly string[]).includes(r));
    if (unknown.length > 0) {
      io.stderr(formatError(UsageError({ message: `Unknown lint rule(s): ${unknown.join(', ')}. Known: ${LINT_RULES.join(', ')}.` })));
      return 2;
    }
    config.rules = rules as LintRule[];
  }
  const flagNames = listFlag(args, 'flag-names');
  if (flagNames !== undefined) config.flagReadNames = flagNames;
  const result = lintPaths(args.positionals, io.cwd, config, { includeTests: args.flags.has('include-tests') });
  io.stdout(args.flags.has('json') ? JSON.stringify(result, null, 2) : formatLintText(result));
  return result.violations.length > 0 ? 1 : 0;
}

function budgetsCommand(args: ParsedArgs, io: CliIo): number {
  const resultsPath = stringFlag(args, 'results');
  if (resultsPath === undefined) {
    io.stderr(formatError(UsageError({ message: '`sf budgets` needs `--results <file>` (the output of `size-limit --json`).' })));
    return 2;
  }
  const threshold = numberFlag(args, 'threshold');
  const headroom = numberFlag(args, 'headroom');
  for (const n of [threshold, headroom]) {
    if (typeof n === 'object') {
      io.stderr(formatError(n));
      return 2;
    }
  }
  const configPath = resolve(io.cwd, stringFlag(args, 'config') ?? '.size-limit.json');
  const config = readBudgetConfig(configPath);
  if (!config.ok) {
    io.stderr(formatError(config.error));
    return 2;
  }
  const results = readBudgetResults(resolve(io.cwd, resultsPath));
  if (!results.ok) {
    io.stderr(formatError(results.error));
    return 2;
  }
  const report = analyzeBudgets(config.value, results.value, {
    ...(typeof threshold === 'number' ? { threshold } : {}),
    ...(typeof headroom === 'number' ? { headroom } : {}),
  });
  io.stdout(args.flags.has('json') ? JSON.stringify(report, null, 2) : formatBudgetTable(report));
  if (args.flags.has('write') && report.proposals.length > 0) {
    writeBudgetConfig(configPath, applyRatchet(config.value, report));
    io.stdout(`Tightened ${report.proposals.length} budget(s) in ${configPath}.`);
  }
  return report.overCount > 0 ? 1 : 0;
}

function agentsCommand(args: ParsedArgs, io: CliIo): number {
  const packages = listFlag(args, 'packages');
  const sizeLimitPath = stringFlag(args, 'size-limit');
  const check = args.flags.has('check');
  const result = updateAgentsFiles({ root: io.cwd, check, ...(packages === undefined ? {} : { packages }), ...(sizeLimitPath === undefined ? {} : { sizeLimitPath }) });
  for (const e of result.errors) io.stderr(formatError(e));
  for (const u of result.updates) {
    if (u.status !== 'unchanged') io.stdout(`${check ? 'stale' : u.status}: ${u.file}`);
  }
  const stale = result.updates.filter((u) => u.status !== 'unchanged').length;
  io.stdout(`${result.updates.length} AGENTS.md file(s) checked, ${stale} ${check ? 'stale' : 'written'}.`);
  if (result.errors.length > 0) return 2;
  return check && stale > 0 ? 1 : 0;
}

async function routesCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const entry = args.positionals[0];
  if (entry === undefined) {
    io.stderr(formatError(UsageError({ message: '`sf routes` needs an entry module path.' })));
    return 2;
  }
  const loaded = await loadRoutesModule(entry, io.cwd, io.importer);
  if (!loaded.ok) {
    io.stderr(formatError(loaded.error));
    return 2;
  }
  const result = checkRoutes(loaded.value);
  io.stdout(args.flags.has('json') ? formatRoutesJson(result) : formatRoutesText(result));
  return result.errorCount > 0 ? 1 : 0;
}

function manifestCommand(args: ParsedArgs, io: CliIo): number {
  const file = args.positionals[0];
  if (file === undefined) {
    io.stderr(formatError(UsageError({ message: '`sf manifest` needs the path of an sf-manifest.json.' })));
    return 2;
  }
  const maxEagerKb = numberFlag(args, 'max-eager-kb');
  if (typeof maxEagerKb === 'object') {
    io.stderr(formatError(maxEagerKb));
    return 2;
  }
  const maxBootKb = numberFlag(args, 'max-boot-kb');
  if (typeof maxBootKb === 'object') {
    io.stderr(formatError(maxBootKb));
    return 2;
  }
  const manifestPath = resolve(io.cwd, file);
  const json = readJson(manifestPath);
  if (!json.ok) {
    io.stderr(formatError(json.error));
    return 2;
  }
  // The build report next to the manifest (both plugins emit it) unless `--report <file>` / `--no-report`.
  const reportFlag = stringFlag(args, 'report');
  const reportPath = reportFlag !== undefined ? resolve(io.cwd, reportFlag) : join(dirname(manifestPath), 'sf-build-report.json');
  let report: unknown;
  if (!args.flags.has('no-report') && (reportFlag !== undefined || existsSync(reportPath))) {
    const read = readJson(reportPath);
    if (!read.ok) {
      io.stderr(formatError(read.error));
      return 2;
    }
    report = read.value;
  }
  const result = checkManifest(json.value, {
    ...(typeof maxEagerKb === 'number' ? { maxEagerKb } : {}),
    ...(typeof maxBootKb === 'number' ? { maxBootKb } : {}),
    ...(report === undefined ? {} : { report }),
  });
  io.stdout(args.flags.has('json') ? JSON.stringify(result, null, 2) : formatManifestText(result));
  return result.errorCount > 0 ? 1 : 0;
}

/** Real process runner for `sf publish` (inherits env: NODE_AUTH_TOKEN / OIDC, NPM_CONFIG_PROVENANCE). */
const processRunner: Runner = {
  run: (command, args, cwd) =>
    new Promise((resolveRun) => {
      const child = spawn(command, [...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => resolveRun({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
      child.on('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    }),
};

async function publishCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const numbers: Record<string, number | undefined> = {};
  for (const name of ['delay-ms', 'max-attempts', 'backoff-ms', 'max-backoff-ms']) {
    const value = numberFlag(args, name);
    if (typeof value === 'object') {
      io.stderr(formatError(value));
      return 2;
    }
    numbers[name] = value;
  }
  const report = await publishPackages(discoverPackages(io.cwd), {
    runner: processRunner,
    root: io.cwd,
    log: io.stdout,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    dryRun: args.flags.has('dry-run'),
    ...(numbers['delay-ms'] === undefined ? {} : { delayMs: numbers['delay-ms'] }),
    ...(numbers['max-attempts'] === undefined ? {} : { maxAttempts: numbers['max-attempts'] }),
    ...(numbers['backoff-ms'] === undefined ? {} : { initialBackoffMs: numbers['backoff-ms'] }),
    ...(numbers['max-backoff-ms'] === undefined ? {} : { maxBackoffMs: numbers['max-backoff-ms'] }),
  });
  io.stdout(`published ${report.published} · skipped ${report.skipped} · failed ${report.failed}`);
  return report.failed > 0 ? 1 : 0;
}

/** Run the CLI; resolves to the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'graph':
      return graphCommand(args, io);
    case 'errors':
      return errorsCommand(args, io);
    case 'lint':
      return lintCommand(args, io);
    case 'budgets':
      return budgetsCommand(args, io);
    case 'agents':
      return agentsCommand(args, io);
    case 'routes':
      return routesCommand(args, io);
    case 'manifest':
      return manifestCommand(args, io);
    case 'publish':
      return publishCommand(args, io);
    case undefined:
    case 'help':
      io.stdout(HELP);
      return 0;
    default:
      io.stderr(formatError(UsageError({ message: `Unknown command "${args.command}".` })));
      io.stderr(HELP);
      return 2;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  });
  process.exitCode = code;
}
