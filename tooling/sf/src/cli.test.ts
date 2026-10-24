// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HELP, parseArgs, runCli } from './cli.js';
import { displayPath, expandGlob, formatError } from './files.js';
import { UsageError } from './errors.js';
import { captureIo, tempDir } from './test-helpers.js';

describe('parseArgs', () => {
  it('splits command, positionals, boolean and value flags', () => {
    const args = parseArgs(['lint', 'a', '--json', '--rules', 'x,y', '--out=f.json', 'b', '--', '--literal']);
    expect(args.command).toBe('lint');
    expect(args.positionals).toEqual(['a', 'b', '--literal']);
    expect(args.flags.get('json')).toBe(true);
    expect(args.flags.get('rules')).toBe('x,y');
    expect(args.flags.get('out')).toBe('f.json');
  });

  it('treats a trailing value flag without a value as boolean', () => {
    expect(parseArgs(['budgets', '--results']).flags.get('results')).toBe(true);
    expect(parseArgs([]).command).toBeUndefined();
  });
});

describe('runCli', () => {
  it('prints help for no command and `help`', async () => {
    const io = captureIo('/');
    expect(await runCli([], io)).toBe(0);
    expect(await runCli(['help'], io)).toBe(0);
    expect(io.out).toEqual([HELP, HELP]);
    for (const command of ['graph', 'errors', 'lint', 'budgets', 'agents']) expect(HELP).toContain(`  ${command}`);
  });

  it('rejects unknown commands with exit 2 and an SF code', async () => {
    const io = captureIo('/');
    expect(await runCli(['frobnicate'], io)).toBe(2);
    expect(io.errs[0]).toContain('SF-TOOL-005');
    expect(io.errs[0]).toContain('frobnicate');
  });
});

describe('files helpers', () => {
  it('expands globs with *, ? and **', () => {
    const dir = tempDir();
    try {
      dir.write('packages/a/src/x.ts', '');
      dir.write('packages/b/src/y.ts', '');
      dir.write('packages/b/src/deep/z.ts', '');
      dir.write('packages/b/node_modules/m/w.ts', '');
      const rel = (ps: string[]): string[] => ps.map((p) => displayPath(p, dir.root));
      expect(rel(expandGlob('packages/*/src', dir.root))).toEqual(['packages/a/src', 'packages/b/src']);
      expect(rel(expandGlob('packages/?/src/*.ts', dir.root))).toEqual(['packages/a/src/x.ts', 'packages/b/src/y.ts']);
      expect(rel(expandGlob('packages/**/*.ts', dir.root))).toEqual(['packages/a/src/x.ts', 'packages/b/src/deep/z.ts', 'packages/b/src/y.ts']);
      expect(rel(expandGlob(`${dir.root}/packages/a`, '/elsewhere'))).toEqual(['packages/a']);
      expect(displayPath(dir.root, dir.root)).toBe('.');
    } finally {
      dir.dispose();
    }
  });

  it('formats errors with code and fix', () => {
    expect(formatError(UsageError({ message: 'bad' }))).toBe('SF-TOOL-005: bad\n  fix: Run `sf help` for the list of commands and their flags.');
  });
});
