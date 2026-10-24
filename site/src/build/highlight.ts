/**
 * A tiny build-time syntax highlighter for the languages the docs use (TypeScript,
 * shell, JSON, YAML, HTML). It tokenizes with one sticky regex per language and wraps
 * tokens in `<span class="tk-…">`. No runtime cost: code blocks ship as static HTML.
 */
import { escapeHtml } from './html.js';

export type Lang = 'ts' | 'sh' | 'json' | 'yaml' | 'html' | 'text';

const TS_KEYWORDS = new Set([
  'import', 'export', 'from', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'in', 'while',
  'await', 'async', 'new', 'class', 'extends', 'static', 'override', 'readonly', 'interface', 'type', 'declare',
  'module', 'as', 'satisfies', 'typeof', 'keyof', 'void', 'this', 'default', 'try', 'catch', 'finally', 'throw',
  'private', 'protected', 'public', 'switch', 'case', 'break', 'continue', 'do', 'instanceof', 'delete', 'yield',
]);
const TS_LITERALS = new Set(['true', 'false', 'null', 'undefined']);

interface Rule {
  readonly cls: string | ((match: string, next: string) => string | undefined);
  readonly re: RegExp;
}

function tsClass(word: string, next: string): string | undefined {
  if (TS_KEYWORDS.has(word)) return 'kw';
  if (TS_LITERALS.has(word)) return 'lit';
  if (/^[A-Z]/.test(word)) return 'type';
  if (next === '(') return 'fn';
  return undefined;
}

const RULES: Readonly<Record<Exclude<Lang, 'text'>, readonly Rule[]>> = {
  ts: [
    { cls: 'com', re: /\/\/[^\n]*/y },
    { cls: 'com', re: /\/\*[\s\S]*?\*\//y },
    { cls: 'str', re: /`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/y },
    { cls: 'str', re: /'(?:\\.|[^'\\\n])*'/y },
    { cls: 'str', re: /"(?:\\.|[^"\\\n])*"/y },
    { cls: 'num', re: /\b\d[\d_]*(?:\.\d+)?\b/y },
    { cls: 'dec', re: /@[A-Za-z]+/y },
    { cls: tsClass, re: /[A-Za-z_$][\w$]*/y },
    { cls: 'pun', re: /=>|[{}()[\];,.:?<>=+\-*/!&|]/y },
  ],
  sh: [
    { cls: 'com', re: /#[^\n]*/y },
    { cls: 'str', re: /'[^'\n]*'|"(?:\\.|[^"\\\n])*"/y },
    { cls: (word) => (/^(pnpm|npx|cd|git|node|npm)$/.test(word) ? 'fn' : undefined), re: /[A-Za-z_][\w-]*/y },
    { cls: 'pun', re: /&&|\||>|\\/y },
  ],
  json: [
    { cls: 'prop', re: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
    { cls: 'str', re: /"(?:\\.|[^"\\])*"/y },
    { cls: 'num', re: /-?\b\d+(?:\.\d+)?\b/y },
    { cls: 'lit', re: /\b(?:true|false|null)\b/y },
  ],
  yaml: [
    { cls: 'com', re: /#[^\n]*/y },
    { cls: 'prop', re: /[\w-]+(?=:)/y },
    { cls: 'str', re: /'[^'\n]*'|"[^"\n]*"/y },
  ],
  html: [
    { cls: 'com', re: /<!--[\s\S]*?-->/y },
    { cls: 'tag', re: /<\/?[a-zA-Z][\w-]*/y },
    { cls: 'prop', re: /[a-zA-Z-:.@?]+(?==)/y },
    { cls: 'str', re: /"[^"]*"/y },
    { cls: 'tag', re: /\/?>/y },
  ],
};

export function highlight(code: string, lang: Lang): string {
  if (lang === 'text') return escapeHtml(code);
  const rules = RULES[lang];
  let out = '';
  let plain = '';
  let i = 0;
  const flush = (): void => {
    if (plain !== '') out += escapeHtml(plain);
    plain = '';
  };
  outer: while (i < code.length) {
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (m === null || m[0] === '') continue;
      const text = m[0];
      const after = code.slice(i + text.length).match(/^\s*(.)/)?.[1] ?? '';
      const cls = typeof rule.cls === 'string' ? rule.cls : rule.cls(text, after);
      if (cls === undefined) {
        plain += text;
      } else {
        flush();
        out += `<span class="tk-${cls}">${escapeHtml(text)}</span>`;
      }
      i += text.length;
      continue outer;
    }
    plain += code[i];
    i += 1;
  }
  flush();
  return out;
}

/** Remove common leading indentation and surrounding blank lines (lets code live indented in TS sources). */
export function dedent(code: string): string {
  const lines = code.replace(/^\n+|\s+$/g, '').split('\n');
  const indents = lines.filter((l) => l.trim() !== '').map((l) => /^ */.exec(l)?.[0].length ?? 0);
  const min = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(min)).join('\n');
}
