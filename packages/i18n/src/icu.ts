/**
 * A small ICU MessageFormat subset: plain args, `number` / `date` / `time` /
 * `list` args, `plural` / `selectordinal` (with `=n`, CLDR categories, `offset:`
 * and `#`) and `select`. Apostrophe quoting follows ICU: `''` is a literal
 * quote and `'{…}'` quotes syntax characters.
 *
 * Parsing returns a `Result` (syntax errors are values). Formatting never
 * throws; missing params are reported through the returned `missing` list.
 */
import { defineError, err, ok, type Result } from '@staticflux/core';
import type { Formatters } from './formatters.js';

export const MessageSyntaxError = defineError(
  'SF-I18N-001',
  'validation',
  'An ICU message has a syntax error.',
  'Check braces and the `other` branch of plural/select args; quote literal braces as `\'{\'`. Run `checkCatalogs()` to list every broken message.',
);

export type PluralSelector = `=${number}` | Intl.LDMLPluralRule;

export type IcuNode =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'arg'; readonly name: string }
  | { readonly type: 'number'; readonly name: string; readonly style: string | undefined }
  | { readonly type: 'date'; readonly name: string; readonly style: string | undefined }
  | { readonly type: 'time'; readonly name: string; readonly style: string | undefined }
  | { readonly type: 'list'; readonly name: string; readonly style: string | undefined }
  | {
      readonly type: 'plural';
      readonly name: string;
      readonly ordinal: boolean;
      readonly offset: number;
      readonly options: Readonly<Record<string, readonly IcuNode[]>>;
    }
  | { readonly type: 'select'; readonly name: string; readonly options: Readonly<Record<string, readonly IcuNode[]>> }
  | { readonly type: 'pound' };

/** The argument kinds a message uses (for placeholder checks). */
export type ArgKind = 'plain' | 'number' | 'date' | 'time' | 'list' | 'plural' | 'selectordinal' | 'select';

const SIMPLE_TYPES = new Set(['number', 'date', 'time', 'list']);
const NAME_CHAR = /[\p{L}\p{N}_$]/u;
const WS = /\s/u;

class Parser {
  private index = 0;
  constructor(private readonly source: string) {}

  parse(): readonly IcuNode[] {
    const nodes = this.nodes(false, 0);
    if (this.index < this.source.length) this.fail('Unexpected "}"');
    return nodes;
  }

  private fail(message: string): never {
    throw new SyntaxFailure(`${message} at offset ${this.index}`);
  }

  private peek(offset = 0): string {
    return this.source.charAt(this.index + offset);
  }

  private skipWs(): void {
    while (this.index < this.source.length && WS.test(this.peek())) this.index += 1;
  }

  private nodes(inPlural: boolean, depth: number): IcuNode[] {
    const out: IcuNode[] = [];
    let text = '';
    const flush = (): void => {
      if (text !== '') out.push({ type: 'text', value: text });
      text = '';
    };
    while (this.index < this.source.length) {
      const ch = this.peek();
      if (ch === "'") {
        text += this.quoted(inPlural);
        continue;
      }
      if (ch === '{') {
        flush();
        this.index += 1;
        out.push(this.argument(inPlural, depth + 1));
        continue;
      }
      if (ch === '}') {
        if (depth === 0) this.fail('Unexpected "}"');
        break;
      }
      if (ch === '#' && inPlural) {
        flush();
        this.index += 1;
        out.push({ type: 'pound' });
        continue;
      }
      text += ch;
      this.index += 1;
    }
    flush();
    return out;
  }

  /** Handles an apostrophe at the current position; returns the literal text it stands for. */
  private quoted(inPlural: boolean): string {
    const next = this.peek(1);
    if (next === "'") {
      this.index += 2;
      return "'";
    }
    const special = next === '{' || next === '}' || (inPlural && next === '#');
    if (!special) {
      this.index += 1;
      return "'";
    }
    this.index += 1; // opening quote
    let out = '';
    while (this.index < this.source.length) {
      const ch = this.peek();
      if (ch === "'") {
        if (this.peek(1) === "'") {
          out += "'";
          this.index += 2;
          continue;
        }
        this.index += 1; // closing quote
        return out;
      }
      out += ch;
      this.index += 1;
    }
    return out; // unterminated quote: the rest is literal (ICU behaviour)
  }

  private name(): string {
    this.skipWs();
    const start = this.index;
    while (this.index < this.source.length && NAME_CHAR.test(this.peek())) this.index += 1;
    const name = this.source.slice(start, this.index);
    if (name === '') this.fail('Expected an argument name');
    this.skipWs();
    return name;
  }

  private word(): string {
    this.skipWs();
    const start = this.index;
    while (this.index < this.source.length && /[A-Za-z]/.test(this.peek())) this.index += 1;
    return this.source.slice(start, this.index);
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.peek() !== ch) this.fail(`Expected "${ch}"`);
    this.index += 1;
  }

  private argument(inPlural: boolean, depth: number): IcuNode {
    const name = this.name();
    if (this.peek() === '}') {
      this.index += 1;
      return { type: 'arg', name };
    }
    this.expect(',');
    const kind = this.word();
    this.skipWs();
    if (SIMPLE_TYPES.has(kind)) {
      let style: string | undefined;
      if (this.peek() === ',') {
        this.index += 1;
        const start = this.index;
        while (this.index < this.source.length && this.peek() !== '}' && this.peek() !== '{') this.index += 1;
        style = this.source.slice(start, this.index).trim();
        if (style === '') style = undefined;
      }
      this.expect('}');
      return { type: kind as 'number' | 'date' | 'time' | 'list', name, style };
    }
    if (kind === 'plural' || kind === 'selectordinal' || kind === 'select') {
      this.expect(',');
      const isPlural = kind !== 'select';
      let offset = 0;
      this.skipWs();
      if (isPlural && this.source.startsWith('offset:', this.index)) {
        this.index += 'offset:'.length;
        this.skipWs();
        const start = this.index;
        while (/[0-9]/.test(this.peek())) this.index += 1;
        offset = Number(this.source.slice(start, this.index));
        if (this.source.slice(start, this.index) === '') this.fail('Expected a number after "offset:"');
      }
      const options: Record<string, readonly IcuNode[]> = {};
      for (;;) {
        this.skipWs();
        if (this.peek() === '}') {
          this.index += 1;
          break;
        }
        if (this.index >= this.source.length) this.fail(`Unterminated ${kind} argument "${name}"`);
        const start = this.index;
        while (this.index < this.source.length && !WS.test(this.peek()) && this.peek() !== '{' && this.peek() !== '}') {
          this.index += 1;
        }
        const selector = this.source.slice(start, this.index);
        if (selector === '') this.fail('Expected a selector');
        if (isPlural && selector.startsWith('=') && !/^=\d+(\.\d+)?$/.test(selector)) this.fail(`Invalid selector "${selector}"`);
        this.expect('{');
        options[selector] = this.nodes(isPlural || inPlural, depth);
        this.expect('}');
      }
      if (options['other'] === undefined) this.fail(`The ${kind} argument "${name}" needs an "other" branch`);
      return isPlural
        ? { type: 'plural', name, ordinal: kind === 'selectordinal', offset, options }
        : { type: 'select', name, options };
    }
    return this.fail(`Unknown argument type "${kind}"`);
  }
}

class SyntaxFailure extends Error {}

/** Parse an ICU message into an AST. */
export function parseMessage(source: string): Result<readonly IcuNode[]> {
  try {
    return ok(new Parser(source).parse());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(MessageSyntaxError({ message: `ICU syntax error: ${message}`, details: { source } }));
  }
}

/** Every argument the message uses, with its kind (first use wins for duplicates of a plain arg). */
export function collectArgs(nodes: readonly IcuNode[]): ReadonlyMap<string, ArgKind> {
  const out = new Map<string, ArgKind>();
  const visit = (list: readonly IcuNode[]): void => {
    for (const node of list) {
      switch (node.type) {
        case 'text':
        case 'pound':
          break;
        case 'arg':
          if (!out.has(node.name)) out.set(node.name, 'plain');
          break;
        case 'plural':
          out.set(node.name, node.ordinal ? 'selectordinal' : 'plural');
          for (const branch of Object.values(node.options)) visit(branch);
          break;
        case 'select':
          out.set(node.name, 'select');
          for (const branch of Object.values(node.options)) visit(branch);
          break;
        default:
          out.set(node.name, node.type);
      }
    }
  };
  visit(nodes);
  return out;
}

export interface FormatOutcome {
  readonly text: string;
  /** Param names the message used but that were not supplied. */
  readonly missing: readonly string[];
}

const NUMBER_STYLES: Readonly<Record<string, Intl.NumberFormatOptions>> = {
  integer: { maximumFractionDigits: 0 },
  percent: { style: 'percent' },
  compact: { notation: 'compact' },
};

function numberOptions(style: string | undefined): Intl.NumberFormatOptions {
  if (style === undefined) return {};
  const preset = NUMBER_STYLES[style];
  if (preset !== undefined) return preset;
  const currency = /^(?:::)?currency\/([A-Za-z]{3})$/.exec(style);
  if (currency?.[1] !== undefined) return { style: 'currency', currency: currency[1].toUpperCase() };
  return {};
}

type DateStyle = 'short' | 'medium' | 'long' | 'full';
const DATE_STYLES = new Set<string>(['short', 'medium', 'long', 'full']);

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  return undefined;
}

/** Format an AST with params. Never throws. */
export function formatNodes(
  nodes: readonly IcuNode[],
  params: Readonly<Record<string, unknown>>,
  formatters: Formatters,
): FormatOutcome {
  const missing: string[] = [];
  const render = (list: readonly IcuNode[], pound: number | undefined): string => {
    let out = '';
    for (const node of list) {
      if (node.type === 'text') {
        out += node.value;
        continue;
      }
      if (node.type === 'pound') {
        out += pound === undefined ? '#' : formatters.number(pound);
        continue;
      }
      const value = params[node.name];
      if (value === undefined) {
        missing.push(node.name);
        out += `{${node.name}}`;
        continue;
      }
      switch (node.type) {
        case 'arg':
          out +=
            typeof value === 'number'
              ? formatters.number(value)
              : value instanceof Date
                ? formatters.date(value)
                : String(value);
          break;
        case 'number':
          out += formatters.number(Number(value), numberOptions(node.style));
          break;
        case 'date':
        case 'time': {
          const date = toDate(value);
          if (date === undefined) {
            out += String(value);
            break;
          }
          const style = (node.style !== undefined && DATE_STYLES.has(node.style) ? node.style : 'medium') as DateStyle;
          out += formatters.date(date, node.type === 'date' ? { dateStyle: style } : { timeStyle: style });
          break;
        }
        case 'list': {
          const items = Array.isArray(value) ? value.map(String) : [String(value)];
          const type: Intl.ListFormatType =
            node.style === 'or' || node.style === 'disjunction' ? 'disjunction' : node.style === 'unit' ? 'unit' : 'conjunction';
          out += formatters.list(items, { type });
          break;
        }
        case 'plural': {
          const n = Number(value);
          const exact = node.options[`=${n}`];
          const branch =
            exact ??
            node.options[formatters.pluralCategory(n - node.offset, node.ordinal ? 'ordinal' : 'cardinal')] ??
            node.options['other'] ??
            [];
          out += render(branch, n - node.offset);
          break;
        }
        case 'select': {
          const branch = node.options[String(value)] ?? node.options['other'] ?? [];
          out += render(branch, pound);
          break;
        }
      }
    }
    return out;
  };
  return { text: render(nodes, undefined), missing };
}
