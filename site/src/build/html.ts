/**
 * Build-time HTML authoring (runs in Node inside vite.config.ts, never in the browser).
 *
 * `html` is a tagged template that escapes every interpolated value unless it is a
 * `Raw` fragment (another `html` result, `raw()`, or an array of those). Pages are plain
 * functions returning `Raw`, so content is type-checked TypeScript, not a template language.
 */

export interface Raw {
  readonly __raw: string;
}

export function raw(value: string): Raw {
  return { __raw: value };
}

export function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && '__raw' in value;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export type Interpolation = Raw | string | number | boolean | null | undefined | readonly Interpolation[];

function render(value: Interpolation): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map((item: Interpolation) => render(item)).join('');
  if (isRaw(value)) return value.__raw;
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: readonly Interpolation[]): Raw {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) out += render(values[i]) + (strings[i + 1] ?? '');
  return raw(out);
}

/** Inline markdown-ish emphasis for prose strings: `code`, **strong**, *em*. Input is escaped first. */
export function md(text: string): Raw {
  const escaped = escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return raw(escaped);
}

/** Paragraphs from a list of prose strings. */
export function paras(...texts: readonly string[]): Raw {
  return raw(texts.map((t) => `<p>${md(t).__raw}</p>`).join(''));
}

/** Stable slug for headings and anchors. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
