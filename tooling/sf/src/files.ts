/**
 * Small filesystem helpers: a minimal glob expander (`*` and `**` per path
 * segment, no braces/classes), JSON reading as `Result`, module importing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { err, ok, type Result, type SfError } from '@staticflux/core';
import { FileReadFailed, InvalidJson, ModuleLoadFailed } from './errors.js';

/** Imports an ES module by absolute path. Injectable for tests. */
export type ModuleImporter = (absolutePath: string) => Promise<Record<string, unknown>>;

export const defaultImporter: ModuleImporter = async (absolutePath) =>
  (await import(/* @vite-ignore */ pathToFileURL(absolutePath).href)) as Record<string, unknown>;

export async function importModule(path: string, cwd: string, importer: ModuleImporter = defaultImporter): Promise<Result<Record<string, unknown>>> {
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) {
    return err(ModuleLoadFailed({ message: `Module "${path}" does not exist (resolved to ${absolute}).`, details: { path: absolute } }));
  }
  try {
    return ok(await importer(absolute));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return err(ModuleLoadFailed({ message: `Importing "${path}" failed: ${reason}`, cause, details: { path: absolute } }));
  }
}

export function readText(path: string): Result<string> {
  try {
    return ok(readFileSync(path, 'utf8'));
  } catch (cause) {
    return err(FileReadFailed({ message: `Cannot read ${path}.`, cause, details: { path } }));
  }
}

export function readJson(path: string): Result<unknown> {
  const text = readText(path);
  if (!text.ok) return text;
  try {
    return ok(JSON.parse(text.value) as unknown);
  } catch (cause) {
    return err(InvalidJson({ message: `${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, cause }));
  }
}

function segmentMatcher(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

/**
 * Expand a pattern (relative to `cwd`, or absolute) into existing paths.
 * Supports `*`/`?` within a segment and `**` for any number of segments.
 */
export function expandGlob(pattern: string, cwd: string): string[] {
  const normalized = pattern.split(sep).join('/');
  const absolute = isAbsolute(normalized);
  const segments = normalized.split('/').filter((s, i) => s.length > 0 || (i === 0 && absolute));
  const start = absolute ? '/' : cwd;
  const parts = absolute ? segments.slice(1) : segments;
  const out = new Set<string>();
  const walk = (base: string, index: number): void => {
    if (index === parts.length) {
      if (existsSync(base)) out.add(base);
      return;
    }
    const part = parts[index] as string;
    if (part === '**') {
      walk(base, index + 1);
      for (const name of listDir(base)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const child = join(base, name);
        if (isDirectory(child)) walk(child, index);
      }
      return;
    }
    if (!part.includes('*') && !part.includes('?')) {
      walk(join(base, part), index + 1);
      return;
    }
    const matcher = segmentMatcher(part);
    for (const name of listDir(base)) if (matcher.test(name)) walk(join(base, name), index + 1);
  };
  walk(start, 0);
  return [...out].sort();
}

/** Every file under `dir` (recursively), skipping node_modules, dist and dot-dirs. */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of listDir(current)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const child = join(current, name);
      if (isDirectory(child)) walk(child);
      else out.push(child);
    }
  };
  walk(dir);
  return out;
}

/** Display path relative to cwd with forward slashes. */
export function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return (rel.length === 0 ? '.' : rel).split(sep).join('/');
}

export function formatError(error: SfError): string {
  return `${error.code}: ${error.message}${error.fix === undefined ? '' : `\n  fix: ${error.fix}`}`;
}
