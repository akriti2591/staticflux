/**
 * `sf budgets` — size budget report and **ratchet** proposals (R12.8, R20.4).
 *
 * Reads `.size-limit.json` and a results file from `size-limit --json`, prints
 * a table, and proposes a tighter limit for every check whose actual size is
 * more than `threshold` (default 10 %) below its limit. The proposed limit is
 * the actual size plus `headroom` (default 5 %), rounded up to 0.1 of the
 * limit's unit. Proposals only ever tighten: a loosening is never produced,
 * and `applyRatchet` refuses to raise a limit.
 */
import { writeFileSync } from 'node:fs';
import { err, ok, type Result } from '@staticflux/core';
import { InvalidJson } from './errors.js';
import { readJson } from './files.js';

export interface SizeLimitCheck {
  readonly name?: string;
  readonly path?: string | readonly string[];
  readonly import?: string;
  readonly limit?: string;
  /** Budget category shown in reports, e.g. `render-wasm` (IF-15.1). */
  readonly category?: string;
  /** `false`: never propose tightening (a requirement ceiling for code that is not written yet). */
  readonly ratchet?: boolean;
  readonly [key: string]: unknown;
}

export interface SizeLimitResult {
  readonly name: string;
  readonly size?: number;
  readonly passed?: boolean;
  readonly sizeLimit?: number;
}

export type BudgetStatus = 'over' | 'ok' | 'ratchet' | 'no-result' | 'no-limit';

export interface BudgetRow {
  readonly index: number;
  readonly name: string;
  readonly category?: string;
  readonly limit: string | undefined;
  readonly limitBytes: number | undefined;
  readonly actualBytes: number | undefined;
  /** actual / limit (e.g. 0.82). */
  readonly usage: number | undefined;
  readonly status: BudgetStatus;
  /** Present when status is `ratchet`. */
  readonly proposedLimit?: string;
}

export interface BudgetOptions {
  /** Propose tightening when actual < limit × (1 − threshold). Default 0.10. */
  readonly threshold?: number;
  /** Headroom over the actual size in proposals. Default 0.05. */
  readonly headroom?: number;
}

export interface BudgetReport {
  readonly rows: readonly BudgetRow[];
  readonly overCount: number;
  readonly proposals: readonly BudgetRow[];
}

const BYTES = /^\s*(\d+(?:\.\d+)?)\s*(?:([kmg])?(i)?b)?\s*$/i;

/** Parse a size-limit limit string (same rules as size-limit: `KB` = 1000 B, `KiB` = 1024 B). */
export function parseBytes(limit: string): number | undefined {
  const match = BYTES.exec(limit);
  if (match === null) return undefined;
  const [, number, prefix, iec] = match;
  const power = prefix === undefined ? 0 : 'kmg'.indexOf(prefix.toLowerCase()) + 1;
  return Math.floor(Number.parseFloat(number as string) * (iec === undefined ? 1000 : 1024) ** power);
}

/** Format bytes in the same unit style as `like` (e.g. "9.5 KB" → "8.3 KB"), rounding up to 0.1 unit. */
export function formatLimitLike(bytes: number, like: string): string {
  const match = BYTES.exec(like);
  const prefix = match?.[2];
  const iec = match?.[3];
  const power = prefix === undefined ? 0 : 'kmg'.indexOf(prefix.toLowerCase()) + 1;
  const base = (iec === undefined ? 1000 : 1024) ** power;
  const unitText = /[a-z]+\s*$/i.exec(like.trim())?.[0] ?? 'B';
  const value = power === 0 ? Math.ceil(bytes) : Math.ceil((bytes / base) * 10) / 10;
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)} ${unitText}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 ** 2) return `${(bytes / 1000).toFixed(2)} kB`;
  return `${(bytes / 1000 ** 2).toFixed(2)} MB`;
}

function isTimeLimit(limit: string): boolean {
  return /\d\s*m?s$/i.test(limit.trim());
}

export function checkName(check: SizeLimitCheck, index: number): string {
  if (typeof check.name === 'string') return check.name;
  if (typeof check.path === 'string') return check.path;
  if (Array.isArray(check.path)) return check.path.join(', ');
  return `check #${index + 1}`;
}

export function analyzeBudgets(config: readonly SizeLimitCheck[], results: readonly SizeLimitResult[], options: BudgetOptions = {}): BudgetReport {
  const threshold = options.threshold ?? 0.1;
  const headroom = options.headroom ?? 0.05;
  const byName = new Map(results.map((r) => [r.name, r]));
  const rows: BudgetRow[] = config.map((check, index) => {
    const name = checkName(check, index);
    const limit = typeof check.limit === 'string' ? check.limit : undefined;
    const limitBytes = limit === undefined || isTimeLimit(limit) ? undefined : parseBytes(limit);
    const actualBytes = byName.get(name)?.size;
    const base = { index, name, ...(typeof check.category === 'string' ? { category: check.category } : {}), limit, limitBytes, actualBytes };
    if (limitBytes === undefined) return { ...base, usage: undefined, status: 'no-limit' as const };
    if (actualBytes === undefined) return { ...base, usage: undefined, status: 'no-result' as const };
    const usage = actualBytes / limitBytes;
    if (actualBytes > limitBytes) return { ...base, usage, status: 'over' as const };
    if (actualBytes < limitBytes * (1 - threshold) && limit !== undefined && check.ratchet !== false) {
      const proposedLimit = formatLimitLike(actualBytes * (1 + headroom), limit);
      const proposedBytes = parseBytes(proposedLimit);
      if (proposedBytes !== undefined && proposedBytes < limitBytes) return { ...base, usage, status: 'ratchet' as const, proposedLimit };
    }
    return { ...base, usage, status: 'ok' as const };
  });
  return { rows, overCount: rows.filter((r) => r.status === 'over').length, proposals: rows.filter((r) => r.status === 'ratchet') };
}

function isCheckArray(value: unknown): value is SizeLimitCheck[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null);
}

function isResultArray(value: unknown): value is SizeLimitResult[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string');
}

export function readBudgetConfig(path: string): Result<SizeLimitCheck[]> {
  const json = readJson(path);
  if (!json.ok) return json;
  if (!isCheckArray(json.value)) return err(InvalidJson({ message: `${path} must be an array of size-limit checks.` }));
  return ok(json.value);
}

export function readBudgetResults(path: string): Result<SizeLimitResult[]> {
  const json = readJson(path);
  if (!json.ok) return json;
  if (!isResultArray(json.value)) return err(InvalidJson({ message: `${path} must be the array printed by \`size-limit --json\`.` }));
  return ok(json.value);
}

/** Return a new config with the proposals applied. Never raises a limit. */
export function applyRatchet(config: readonly SizeLimitCheck[], report: BudgetReport): SizeLimitCheck[] {
  const next = config.map((c) => ({ ...c }));
  for (const row of report.proposals) {
    const current = next[row.index];
    if (current === undefined || row.proposedLimit === undefined || typeof current.limit !== 'string') continue;
    const before = parseBytes(current.limit);
    const after = parseBytes(row.proposedLimit);
    if (before === undefined || after === undefined || after >= before) continue;
    next[row.index] = { ...current, limit: row.proposedLimit };
  }
  return next;
}

export function writeBudgetConfig(path: string, config: readonly SizeLimitCheck[]): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function formatBudgetTable(report: BudgetReport): string {
  const categories = report.rows.some((r) => r.category !== undefined);
  const header = [...(categories ? ['category'] : []), 'check', 'limit', 'actual', 'usage', 'status'];
  const body = report.rows.map((r) => [
    ...(categories ? [r.category ?? '—'] : []),
    r.name,
    r.limit ?? '—',
    r.actualBytes === undefined ? '—' : formatBytes(r.actualBytes),
    r.usage === undefined ? '—' : `${Math.round(r.usage * 100)}%`,
    r.status === 'ratchet' ? `ratchet → ${r.proposedLimit ?? ''}` : r.status,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ').trimEnd();
  const lines = [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)];
  if (report.proposals.length > 0) {
    lines.push('', `Ratchet: ${report.proposals.length} budget(s) can be tightened (R12.8). Apply with \`sf budgets --write\` and commit the change:`);
    for (const p of report.proposals) lines.push(`  ${p.name}: ${p.limit ?? ''} → ${p.proposedLimit ?? ''}`);
  }
  if (report.overCount > 0) lines.push('', `${report.overCount} budget(s) exceeded. Reduce the bundle; raising a limit needs a reviewed reason in the PR.`);
  return lines.join('\n');
}
