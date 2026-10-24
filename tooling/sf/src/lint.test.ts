// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { collectLintFiles, formatLintText, type LintRule, lintPaths, lintSources, type LintViolation } from './lint.js';
import { captureIo, type TempDir, tempDir } from './test-helpers.js';

const lint = (text: string, file = 'packages/x/src/a.ts', rules?: LintRule[]): LintViolation[] =>
  lintSources([{ file, text }], rules === undefined ? {} : { rules });
const rulesOf = (vs: readonly LintViolation[]): string[] => vs.map((v) => v.rule);

describe('no-direct-flag-reads', () => {
  const only: LintRule[] = ['no-direct-flag-reads'];

  it('flags flag(…), readFlag(…), getFlag(…) in feature code', () => {
    const vs = lint('flags.flag(AiPanel);\nreadFlag(AiPanel);\nconfig.getFlag(X);', undefined, only);
    expect(vs).toHaveLength(3);
    expect(vs[0]).toMatchObject({ line: 1, column: 1, rule: 'no-direct-flag-reads' });
    expect(vs[1]?.line).toBe(2);
  });

  it('allows reads in *.bindings.ts and bindings/ dirs', () => {
    expect(lint('flags.flag(A);', 'packages/x/src/editor.bindings.ts', only)).toEqual([]);
    expect(lint('readFlag(A);', 'packages/x/src/bindings/editor.ts', only)).toEqual([]);
    expect(lint('readFlag(A);', 'bindings/editor.ts', only)).toEqual([]);
  });

  it('does not flag declarations or unrelated names', () => {
    expect(lint('export function readFlag(x: unknown) { return x; }\nflagged(1); obj.flags(1);', undefined, only)).toEqual([]);
  });

  it('uses configurable names', () => {
    const vs = lintSources([{ file: 'a.ts', text: 'isEnabled(F); readFlag(F);' }], { rules: only, flagReadNames: ['isEnabled'] });
    expect(vs).toHaveLength(1);
    expect(vs[0]?.message).toContain('isEnabled');
  });
});

describe('no-bare-listener', () => {
  const only: LintRule[] = ['no-bare-listener'];

  it('flags listeners without options or without signal', () => {
    expect(lint("el.addEventListener('click', h);", undefined, only)).toHaveLength(1);
    expect(lint("el.addEventListener('click', h, true);", undefined, only)).toHaveLength(1);
    expect(lint("el.addEventListener('click', h, { passive: true });", undefined, only)).toHaveLength(1);
    expect(lint("addEventListener('resize', h);", undefined, only)).toHaveLength(1);
    expect(lint("el.addEventListener('click', h, opts);", undefined, only)).toHaveLength(1);
  });

  it('accepts { signal } literals, shorthand, same-file option objects, and scope.listen', () => {
    expect(lint("el.addEventListener('click', h, { signal: scope.signal });", undefined, only)).toEqual([]);
    expect(lint("const signal = s; el.addEventListener('click', h, { once: true, signal });", undefined, only)).toEqual([]);
    expect(lint("el.addEventListener('click', h, { ...o, signal } as AddEventListenerOptions);", undefined, only)).toEqual([]);
    expect(lint("const opts = { signal: ac.signal } satisfies AddEventListenerOptions;\nel.addEventListener('click', h, opts);", undefined, only)).toEqual([]);
    expect(lint("scope.listen(window, 'resize', h);", undefined, only)).toEqual([]);
  });

  it('accepts a paired removal registered with scope.defer in the same function', () => {
    const paired = "function f(t, h, scope) {\n  t.addEventListener('x', h);\n  scope.defer(() => t.removeEventListener('x', h));\n}";
    expect(lint(paired, undefined, only)).toEqual([]);
    const otherType = "function f(t, h, scope) {\n  t.addEventListener('x', h);\n  scope.defer(() => t.removeEventListener('y', h));\n}";
    expect(lint(otherType, undefined, only)).toHaveLength(1);
    const notDeferred = "function f(t, h) {\n  t.addEventListener('x', h);\n  t.removeEventListener('x', h);\n}";
    expect(lint(notDeferred, undefined, only)).toHaveLength(1);
    const otherFunction = "function f(t, h) { t.addEventListener('x', h); }\nfunction g(t, h, scope) { scope.defer(() => t.removeEventListener('x', h)); }";
    expect(lint(otherFunction, undefined, only)).toHaveLength(1);
  });
});

describe('inheritance-depth', () => {
  const only: LintRule[] = ['inheritance-depth'];

  it('allows one level and allowed bases', () => {
    const text = 'class A extends LitElement {}\nclass E extends Error {}\nclass B extends SfElement {}\nclass C extends Base {}\nclass Base {}\nclass M extends Mixin(LitElement) {}';
    expect(lint(text, undefined, only)).toEqual([]);
  });

  it('flags chains deeper than one within the repo, across files', () => {
    const vs = lintSources(
      [
        { file: 'a.ts', text: 'export class Base extends LitElement {}' },
        { file: 'b.ts', text: 'export class Mid extends Base {}\nexport class Leaf extends Mid {}' },
      ],
      { rules: only },
    );
    expect(vs.map((v) => `${v.file}:${v.line}`)).toEqual(['b.ts:1', 'b.ts:2']);
    expect(vs[0]?.message).toContain('Mid → Base → LitElement');
    expect(vs[1]?.message).toContain('depth 3');
  });

  it('treats SfElement as a terminal base even when declared in the repo', () => {
    const vs = lintSources([{ file: 'a.ts', text: 'class SfElement extends LitElement {}\nclass Card extends SfElement {}' }], { rules: only });
    expect(vs).toEqual([]);
  });

  it('checks class expressions, survives cycles and honours max depth', () => {
    expect(lint('class Base extends Other {}\nconst X = class extends Base {};', undefined, only)[0]?.message).toContain('(anonymous class)');
    expect(lint('class A extends B {}\nclass B extends A {}', undefined, only)).toHaveLength(2);
    expect(lintSources([{ file: 'a.ts', text: 'class Base extends Other {}\nclass X extends Base {}' }], { rules: only, maxInheritanceDepth: 2 })).toEqual([]);
  });
});

describe('no-string-tokens', () => {
  const only: LintRule[] = ['no-string-tokens'];

  it('flags string lookups on injector-like receivers', () => {
    const text = [
      "inject('auth/session');",
      "injector.get('auth/session');",
      "ctx.injector.handle(`data/store`);",
      "appInjector.functional('x/y');",
      "this.inject('x/y');",
      "container.resolve('x');",
    ].join('\n');
    const vs = lint(text, undefined, only);
    expect(vs.map((v) => v.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(vs[0]?.message).toContain("inject('auth/session')");
  });

  it('ignores typed tokens and non-injector receivers', () => {
    const text = "injector.get(SessionToken);\nmap.get('key');\nheaders.get('content-type');\nparams.has('q');\ninject(Token);\nget('x');";
    expect(lint(text, undefined, only)).toEqual([]);
  });
});

describe('no-default-export', () => {
  const only: LintRule[] = ['no-default-export'];

  it('flags every default-export form', () => {
    const text = 'export default 1;\nexport default function f() {}\nexport default class K {}\nexport { x as default };\nexport { default } from "./m.js";';
    expect(lint(text, undefined, only).map((v) => v.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('allows named exports and export =', () => {
    expect(lint('export const a = 1;\nexport function f() {}\nexport { a as b };', undefined, only)).toEqual([]);
    expect(lint('export = foo;', undefined, only)).toEqual([]);
  });
});

describe('suppression and config', () => {
  it('honours sf-lint-disable-next-line with and without rule lists', () => {
    const text = [
      '// sf-lint-disable-next-line no-bare-listener -- third-party API',
      "el.addEventListener('x', h);",
      '// sf-lint-disable-next-line',
      'export default 1;',
      '// sf-lint-disable-next-line no-default-export',
      "el.addEventListener('y', h);",
    ].join('\n');
    expect(lint(text).map((v) => `${v.line} ${v.rule}`)).toEqual(['6 no-bare-listener']);
  });

  it('runs all rules by default and only selected rules when configured', () => {
    const text = "export default 1;\nreadFlag(F);\nel.addEventListener('x', h);";
    expect(rulesOf(lint(text)).sort()).toEqual(['no-bare-listener', 'no-default-export', 'no-direct-flag-reads']);
    expect(rulesOf(lint(text, undefined, ['no-default-export']))).toEqual(['no-default-export']);
  });

  it('parses tsx', () => {
    expect(lint('export default () => <div onClick={h} />;', 'a.tsx')).toHaveLength(1);
  });
});

describe('files and CLI', () => {
  let dir: TempDir;
  afterEach(() => dir.dispose());

  function fixture(): TempDir {
    const d = tempDir();
    d.write('packages/a/src/index.ts', 'export default 1;\n');
    d.write('packages/a/src/index.test.ts', 'export default 1;\n');
    d.write('packages/a/src/types.d.ts', 'export default 1;\n');
    d.write('packages/a/src/__tests__/x.ts', 'export default 1;\n');
    d.write('packages/b/src/deep/ok.ts', 'export const ok = 1;\n');
    d.write('packages/b/src/readme.md', 'x');
    d.write('packages/b/dist/index.ts', 'export default 1;\n');
    return d;
  }

  it('collects sources, excluding tests, .d.ts, dist and non-ts files', () => {
    dir = fixture();
    const files = collectLintFiles(['packages/*/src'], dir.root).map((f) => f.slice(dir.root.length + 1));
    expect(files).toEqual(['packages/a/src/index.ts', 'packages/b/src/deep/ok.ts']);
    const withTests = collectLintFiles(['packages/a/src'], dir.root, { includeTests: true }).map((f) => f.slice(dir.root.length + 1));
    expect(withTests).toContain('packages/a/src/index.test.ts');
    expect(collectLintFiles(['packages/**/ok.ts'], dir.root)).toHaveLength(1);
    expect(collectLintFiles(['nope/*'], dir.root)).toEqual([]);
  });

  it('lintPaths uses the default packages/*/src and relative display paths', () => {
    dir = fixture();
    const result = lintPaths([], dir.root);
    expect(result.files).toBe(2);
    expect(formatLintText(result).split('\n')[0]).toBe('packages/a/src/index.ts:1:1 no-default-export Default export; use a named export so imports are greppable and renames are tracked.');
  });

  it('sf lint exits 1 on violations, 0 when clean; --json; --rules; bad rule → 2', async () => {
    dir = fixture();
    const io = captureIo(dir.root);
    expect(await runCli(['lint'], io)).toBe(1);
    expect(io.out.join('\n')).toContain('1 violation(s) in 2 file(s).');
    expect(await runCli(['lint', 'packages/b/src'], captureIo(dir.root))).toBe(0);
    const json = captureIo(dir.root);
    await runCli(['lint', '--json'], json);
    expect((JSON.parse(json.out.join('')) as { violations: LintViolation[] }).violations[0]?.rule).toBe('no-default-export');
    expect(await runCli(['lint', '--rules', 'no-bare-listener'], captureIo(dir.root))).toBe(0);
    const bad = captureIo(dir.root);
    expect(await runCli(['lint', '--rules=nope'], bad)).toBe(2);
    expect(bad.errs[0]).toContain('SF-TOOL-005');
  });

  it('sf lint --flag-names and --include-tests', async () => {
    dir = tempDir();
    dir.write('src/a.ts', 'isOn(F);\n');
    dir.write('src/a.test.ts', 'readFlag(F);\n');
    expect(await runCli(['lint', 'src'], captureIo(dir.root))).toBe(0);
    expect(await runCli(['lint', 'src', '--include-tests'], captureIo(dir.root))).toBe(1);
    expect(await runCli(['lint', 'src/a.ts', '--flag-names', 'isOn'], captureIo(dir.root))).toBe(1);
  });
});
