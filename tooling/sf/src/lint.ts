/**
 * `sf lint` — StaticFlux-specific static rules (R20.5) on the TypeScript
 * compiler API. Purely syntactic (one `ts.createSourceFile` per file, no
 * type checker), so it is fast and needs no tsconfig; the heuristics are
 * documented on each rule below and in AGENTS.md.
 *
 * Suppress a finding with a comment on the line above:
 *   // sf-lint-disable-next-line no-bare-listener -- reason
 * (omit the rule list to suppress every rule for that line).
 */
import { statSync } from 'node:fs';
import ts from 'typescript';
import { displayPath, expandGlob, listFilesRecursive, readText } from './files.js';

export const LINT_RULES = ['no-direct-flag-reads', 'no-bare-listener', 'inheritance-depth', 'no-string-tokens', 'no-default-export'] as const;
export type LintRule = (typeof LINT_RULES)[number];

export interface LintConfig {
  readonly rules: readonly LintRule[];
  /** no-direct-flag-reads: call names that read a flag (`x.flag(…)`, `readFlag(…)`). */
  readonly flagReadNames: readonly string[];
  /** no-direct-flag-reads: a file is a bindings file if its path ends with / contains one of these. */
  readonly flagBindingPaths: readonly string[];
  /** inheritance-depth: base classes that end the chain (count as the single allowed level). */
  readonly allowedBaseClasses: readonly string[];
  readonly maxInheritanceDepth: number;
  /** no-string-tokens: free functions checked with any first-arg string literal. */
  readonly tokenFunctions: readonly string[];
  /** no-string-tokens: methods checked when the receiver looks like an injector. `inject` is checked on any receiver. */
  readonly injectorMethods: readonly string[];
  /** no-string-tokens: receiver name (last identifier before the method) that marks an injector. */
  readonly injectorReceiver: RegExp;
}

export const DEFAULT_LINT_CONFIG: LintConfig = {
  rules: LINT_RULES,
  flagReadNames: ['flag', 'readFlag', 'getFlag'],
  flagBindingPaths: ['.bindings.ts', '/bindings/'],
  allowedBaseClasses: ['Error', 'LitElement', 'HTMLElement', 'SfElement'],
  maxInheritanceDepth: 1,
  tokenFunctions: ['inject'],
  injectorMethods: ['inject', 'get', 'handle', 'functional', 'resolve', 'has'],
  injectorReceiver: /^(?:injector|inj|container|di|\w*Injector)$/,
};

export const DEFAULT_LINT_PATHS = ['packages/*/src'] as const;

export interface LintViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: LintRule;
  readonly message: string;
}

export interface LintSource {
  /** Display path (used in output and for bindings-path matching). */
  readonly file: string;
  readonly text: string;
}

const SOURCE_EXTENSION = /\.(?:[cm]?ts|tsx)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?tsx?$)|(?:\/__tests__\/)/;

export interface CollectLintFilesOptions {
  readonly includeTests?: boolean;
}

/** Expand globs/dirs/files into lintable TypeScript sources (tests and .d.ts excluded by default). */
export function collectLintFiles(patterns: readonly string[], cwd: string, options: CollectLintFilesOptions = {}): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const match of expandGlob(pattern, cwd)) {
      let isDir = false;
      try {
        isDir = statSync(match).isDirectory();
      } catch {
        continue;
      }
      for (const file of isDir ? listFilesRecursive(match) : [match]) out.add(file);
    }
  }
  return [...out]
    .filter((f) => SOURCE_EXTENSION.test(f) && !DECLARATION_FILE.test(f))
    .filter((f) => options.includeTests === true || !TEST_FILE.test(f.split('\\').join('/')))
    .sort();
}

interface ClassRecord {
  readonly parent: string | undefined;
}

type ClassIndex = Map<string, ClassRecord[]>;

function heritageName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  // Mixins (`extends Mixin(Base)`) are composition: the chain is cut at the call.
  if (ts.isCallExpression(expression)) return heritageName(expression.expression);
  return undefined;
}

function extendsOf(node: ts.ClassLikeDeclaration): ts.ExpressionWithTypeArguments | undefined {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) return clause.types[0];
  }
  return undefined;
}

function parse(source: LintSource): ts.SourceFile {
  const kind = source.file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true, kind);
}

function indexClasses(files: readonly ts.SourceFile[]): ClassIndex {
  const index: ClassIndex = new Map();
  for (const sf of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const parent = extendsOf(node);
        const list = index.get(node.name.text) ?? [];
        list.push({ parent: parent === undefined ? undefined : heritageName(parent.expression) });
        index.set(node.name.text, list);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return index;
}

/** Chain of class names from `name` upwards (inside the repo), ending at an allowed/external base. */
function inheritanceChain(parent: string, index: ClassIndex, allowed: ReadonlySet<string>): string[] {
  const chain: string[] = [parent];
  const seen = new Set<string>([parent]);
  let current = parent;
  while (!allowed.has(current)) {
    const record = index.get(current)?.[0];
    const next = record?.parent;
    if (next === undefined || seen.has(next)) break;
    chain.push(next);
    seen.add(next);
    current = next;
  }
  return chain;
}

function suppressed(sf: ts.SourceFile, line: number, rule: LintRule): boolean {
  if (line === 0) return false;
  const lineStarts = sf.getLineStarts();
  const start = lineStarts[line - 1];
  const end = lineStarts[line];
  if (start === undefined) return false;
  const previous = sf.text.slice(start, end ?? sf.text.length);
  const match = /\/\/\s*sf-lint-disable-next-line(?:\s+([\w\-,\s]+?))?(?:\s+--.*)?\s*$/.exec(previous);
  if (match === null) return false;
  const listed = match[1];
  if (listed === undefined || listed.trim().length === 0) return true;
  return listed
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .includes(rule);
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function receiverName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const receiver = callee.expression;
  if (ts.isIdentifier(receiver)) return receiver.text;
  if (ts.isPropertyAccessExpression(receiver)) return receiver.name.text;
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return undefined;
}

function objectHasSignal(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some(
    (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'signal',
  );
}

/** Resolve an identifier to a same-file `const x = { … }` initializer. */
function findObjectInitializer(sf: ts.SourceFile, name: string): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined) {
      let init: ts.Expression = node.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function listenerOptionsHaveSignal(sf: ts.SourceFile, options: ts.Expression | undefined): boolean {
  if (options === undefined) return false;
  let expr = options;
  while (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isObjectLiteralExpression(expr)) return objectHasSignal(expr);
  if (ts.isIdentifier(expr)) {
    const init = findObjectInitializer(sf, expr.text);
    return init !== undefined && objectHasSignal(init);
  }
  return false;
}

/**
 * A listener is also scoped when the same function registers its removal in a
 * scope: `scope.defer(() => target.removeEventListener(type, listener))` with
 * the same type and listener expressions.
 */
function hasScopedRemoval(sf: ts.SourceFile, call: ts.CallExpression): boolean {
  const type = call.arguments[0]?.getText(sf);
  const listener = call.arguments[1]?.getText(sf);
  if (type === undefined || listener === undefined) return false;
  let container: ts.Node = call.parent;
  while (!ts.isFunctionLike(container) && !ts.isSourceFile(container)) container = container.parent;
  let found = false;
  const visitRemoval = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && calleeName(node) === 'removeEventListener' && node.arguments[0]?.getText(sf) === type && node.arguments[1]?.getText(sf) === listener) found = true;
    ts.forEachChild(node, visitRemoval);
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && calleeName(node) === 'defer') node.arguments.forEach(visitRemoval);
    ts.forEachChild(node, visit);
  };
  visit(container);
  return found;
}

function isStringLiteralLike(node: ts.Expression | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function isBindingsFile(file: string, config: LintConfig): boolean {
  const normalized = `/${file.split('\\').join('/')}`;
  return config.flagBindingPaths.some((p) => normalized.endsWith(p) || normalized.includes(p));
}

function lintSourceFile(sf: ts.SourceFile, file: string, config: LintConfig, classes: ClassIndex): LintViolation[] {
  const enabled = new Set(config.rules);
  const out: LintViolation[] = [];
  const allowedBases = new Set(config.allowedBaseClasses);
  const flagNames = new Set(config.flagReadNames);
  const tokenFunctions = new Set(config.tokenFunctions);
  const injectorMethods = new Set(config.injectorMethods);
  const bindings = isBindingsFile(file, config);

  const report = (node: ts.Node, rule: LintRule, message: string): void => {
    if (!enabled.has(rule)) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (suppressed(sf, line, rule)) return;
    out.push({ file, line: line + 1, column: character + 1, rule, message });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && flagNames.has(name) && !bindings) {
        report(node, 'no-direct-flag-reads', `Direct flag read \`${name}(…)\` outside a bindings file; declare a variant binding in a \`*.bindings.ts\` file instead (no if/else on flags in feature code).`);
      }
      if (name === 'addEventListener' && !listenerOptionsHaveSignal(sf, node.arguments[2]) && !hasScopedRemoval(sf, node)) {
        report(node, 'no-bare-listener', 'addEventListener without `{ signal }` options or a `scope.defer(() => removeEventListener(…))`; use `scope.listen(target, type, handler)` or pass `{ signal: scope.signal }`.');
      }
      if (name !== undefined && isStringLiteralLike(node.arguments[0])) {
        const receiver = receiverName(node);
        const isFree = ts.isIdentifier(node.expression) && tokenFunctions.has(name);
        const isMethod =
          ts.isPropertyAccessExpression(node.expression) && injectorMethods.has(name) && (name === 'inject' || (receiver !== undefined && config.injectorReceiver.test(receiver)));
        if (isFree || isMethod) {
          report(node, 'no-string-tokens', `String token \`${name}('${node.arguments[0].text}')\`; look dependencies up with a typed token from \`token('pkg/name').type<T>()\`.`);
        }
      }
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const heritage = extendsOf(node);
      const parent = heritage === undefined ? undefined : heritageName(heritage.expression);
      if (parent !== undefined) {
        const chain = inheritanceChain(parent, classes, allowedBases);
        if (chain.length > config.maxInheritanceDepth) {
          const self = node.name?.text ?? '(anonymous class)';
          report(heritage ?? node, 'inheritance-depth', `Class ${self} has inheritance depth ${chain.length} (${[self, ...chain].join(' → ')}); max is ${config.maxInheritanceDepth}. Compose instead of extending.`);
        }
      }
    }

    if (ts.isExportAssignment(node) && node.isExportEquals !== true) {
      report(node, 'no-default-export', 'Default export; use a named export so imports are greppable and renames are tracked.');
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && hasModifier(node, ts.SyntaxKind.ExportKeyword) && hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
      report(node, 'no-default-export', 'Default export; use a named export so imports are greppable and renames are tracked.');
    } else if (ts.isExportSpecifier(node) && node.name.text === 'default') {
      report(node, 'no-default-export', 'Re-export as `default`; use a named export.');
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Lint in-memory sources. The class index for `inheritance-depth` spans all given sources. */
export function lintSources(sources: readonly LintSource[], config: Partial<LintConfig> = {}): LintViolation[] {
  const full: LintConfig = { ...DEFAULT_LINT_CONFIG, ...config };
  const parsed = sources.map((s) => ({ source: s, sf: parse(s) }));
  const classes = indexClasses(parsed.map((p) => p.sf));
  return parsed.flatMap((p) => lintSourceFile(p.sf, p.source.file, full, classes));
}

export interface LintFilesResult {
  readonly files: number;
  readonly violations: readonly LintViolation[];
}

export function lintPaths(patterns: readonly string[], cwd: string, config: Partial<LintConfig> = {}, options: CollectLintFilesOptions = {}): LintFilesResult {
  const files = collectLintFiles(patterns.length > 0 ? patterns : DEFAULT_LINT_PATHS, cwd, options);
  const sources: LintSource[] = [];
  for (const file of files) {
    const text = readText(file);
    if (text.ok) sources.push({ file: displayPath(file, cwd), text: text.value });
  }
  return { files: sources.length, violations: lintSources(sources, config) };
}

export function formatLintText(result: LintFilesResult): string {
  const lines = result.violations.map((v) => `${v.file}:${v.line}:${v.column} ${v.rule} ${v.message}`);
  lines.push(`${result.violations.length} violation(s) in ${result.files} file(s).`);
  return lines.join('\n');
}
