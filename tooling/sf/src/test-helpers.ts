// Shared helpers for the sf tests (temp-dir fixtures, captured CLI output). Not shipped.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliIo } from './cli.js';

export interface TempDir {
  readonly root: string;
  write(path: string, content: string): string;
  dispose(): void;
}

/**
 * A fresh temp directory. `importable` places it inside this package
 * (node_modules/.sf-test) because Vitest only imports modules under the
 * workspace root; everything else uses the OS temp dir.
 */
export function tempDir(options: { importable?: boolean } = {}): TempDir {
  let base = tmpdir();
  if (options.importable === true) {
    base = fileURLToPath(new URL('../node_modules/.sf-test', import.meta.url));
    mkdirSync(base, { recursive: true });
  }
  const root = mkdtempSync(join(base, 'sf-test-'));
  return {
    root,
    write(path, content) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return full;
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function captureIo(cwd: string, extra: Partial<CliIo> = {}): CliIo & { out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  return { cwd, stdout: (t) => out.push(t), stderr: (t) => errs.push(t), out, errs, ...extra };
}
