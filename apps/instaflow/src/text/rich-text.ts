/**
 * Rich text over `DocumentCRDTv2` (B2; IF-21.1–21.6): read a text element as paragraphs and styled runs, and build
 * the `PartOp`s for every edit (insert, delete, marks, paragraph styles, split, create, duplicate). Ops go through
 * the repo (`doc.commit` / `doc.gesture`) like every other edit, one commit per gesture (A4).
 *
 * Offsets are UTF-16 into the content **without** its final paragraph break, which is exactly the layout block's
 * text (paragraphs joined by `\n`), so editor, layout, `TextInput` and CRDT share one coordinate space.
 * Selections that must survive concurrent edits are kept as anchors (`anchorRange` / `resolveRange`).
 */
import { err, ok, type Result } from '@staticflux/core';
import type { DocumentCRDTv2, JsonValue, NodeId, PartOp, TextAnchor } from '@staticflux/document/v2';
import { NotATextNodeError, TextRangeError, TextStyleInvalidError } from './errors.js';
import {
  type CharMarkKey,
  type CharStyle,
  charStyleOf,
  checkCharMark,
  checkParagraphField,
  MATCH_KEY_PATH,
  PARA_FIELDS,
  type ParagraphStyle,
  paragraphMarks,
  paragraphStyleOf,
  TEXT_CONTENT,
  TEXT_KIND,
} from './model.js';

export interface TextRun {
  /** Block offsets, `[start, end)`. */
  readonly start: number;
  readonly end: number;
  readonly style: CharStyle;
}

export interface TextParagraph {
  readonly index: number;
  /** Block offsets of the paragraph text (its break is at `end`). */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly style: ParagraphStyle;
  /** Contiguous runs covering `[start, end)` (one empty run for an empty paragraph). */
  readonly runs: readonly TextRun[];
}

export interface TextBlockModel {
  readonly node: NodeId;
  /** The block text: content without its final break. */
  readonly text: string;
  readonly paragraphs: readonly TextParagraph[];
}

const BREAK = '\n';

function content(part: DocumentCRDTv2, node: NodeId): Result<{ text: string; spans: readonly { start: number; end: number; marks: Readonly<Record<string, JsonValue>> }[] }> {
  const record = part.node(node);
  const rich = record === undefined ? undefined : part.text(node, TEXT_CONTENT);
  if (record === undefined || record.kind !== TEXT_KIND || rich === undefined) return err(NotATextNodeError({ details: { node } }));
  return ok(rich.text.endsWith(BREAK) ? rich : { text: `${rich.text}${BREAK}`, spans: rich.spans });
}

function marksAt(spans: readonly { start: number; end: number; marks: Readonly<Record<string, JsonValue>> }[], from: number, to: number): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const s of spans) if (s.start <= from && s.end >= to && s.end > s.start) Object.assign(out, s.marks);
  return out;
}

/** Read a text element as paragraphs and runs (per-node read; no document materialization). */
export function readTextBlock(part: DocumentCRDTv2, node: NodeId): Result<TextBlockModel> {
  const c = content(part, node);
  if (!c.ok) return c;
  const { text: full, spans } = c.value;
  const paragraphs: TextParagraph[] = [];
  let start = 0;
  for (let i = 0; i < full.length; i++) {
    if (full[i] !== BREAK) continue;
    const end = i;
    // boundaries where any span starts or ends inside the paragraph
    const cuts = new Set<number>([start, end]);
    for (const s of spans) {
      if (s.start > start && s.start < end) cuts.add(s.start);
      if (s.end > start && s.end < end) cuts.add(s.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const runs: TextRun[] = [];
    for (let k = 0; k + 1 < points.length; k++) {
      const a = points[k] as number;
      const b = points[k + 1] as number;
      const style = charStyleOf(marksAt(spans, a, b));
      const prev = runs.at(-1);
      if (prev !== undefined && JSON.stringify(prev.style) === JSON.stringify(style)) runs[runs.length - 1] = { start: prev.start, end: b, style };
      else runs.push({ start: a, end: b, style });
    }
    if (runs.length === 0) runs.push({ start, end, style: charStyleOf(start > 0 ? marksAt(spans, start - 1, start) : {}) });
    paragraphs.push({ index: paragraphs.length, start, end, text: full.slice(start, end), style: paragraphStyleOf(marksAt(spans, end, end + 1)), runs });
    start = i + 1;
  }
  return ok({ node, text: full.slice(0, -1), paragraphs });
}

/** Paragraph containing a block offset (a break belongs to the paragraph it ends). */
export function paragraphAt(block: TextBlockModel, offset: number): TextParagraph {
  return block.paragraphs.find((p) => offset <= p.end) ?? (block.paragraphs.at(-1) as TextParagraph);
}

function checkRange(block: TextBlockModel, from: number, to: number): Result<void> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > block.text.length) {
    return err(TextRangeError({ details: { from, to, length: block.text.length } }));
  }
  return ok(undefined);
}

function paragraphMarkOps(node: NodeId, at: number, style: ParagraphStyle, clearOthers: boolean): PartOp[] {
  const marks = paragraphMarks(style);
  const ops: PartOp[] = [];
  for (const [, key] of PARA_FIELDS) {
    const value = marks[key];
    if (value !== undefined) ops.push({ op: 'text.mark', node, path: TEXT_CONTENT, from: at, to: at + 1, key, value });
    else if (clearOthers) ops.push({ op: 'text.mark', node, path: TEXT_CONTENT, from: at, to: at + 1, key, value: null });
  }
  return ops;
}

/**
 * Insert `text` at `at`. Typed text takes the marks typing would give it (expand rules), or exactly `style` when
 * given. Each inserted `\n` starts a paragraph that keeps the current paragraph's style.
 */
export function insertTextOps(block: TextBlockModel, at: number, text: string, style?: CharStyle): Result<PartOp[]> {
  const range = checkRange(block, at, at);
  if (!range.ok) return range;
  if (style !== undefined) {
    const bad = checkStyle(style);
    if (bad !== undefined) return err(bad);
  }
  if (text.length === 0) return ok([]);
  const ops: PartOp[] = [{ op: 'text.insert', node: block.node, path: TEXT_CONTENT, at, text, ...(style === undefined ? {} : { marks: style as Record<string, JsonValue> }) }];
  const para = paragraphAt(block, at).style;
  for (let i = text.indexOf(BREAK); i >= 0; i = text.indexOf(BREAK, i + 1)) ops.push(...paragraphMarkOps(block.node, at + i, para, true));
  return ok(ops);
}

/** Split the paragraph at `at` (Enter); the new paragraph keeps the style. */
export function splitParagraphOps(block: TextBlockModel, at: number): Result<PartOp[]> {
  return insertTextOps(block, at, BREAK);
}

/**
 * Delete `[from, to)`. Deleting breaks merges paragraphs; the merged paragraph keeps the **first** paragraph's style
 * (its surviving break is re-marked). The final break of the content is never deleted.
 */
export function deleteTextOps(block: TextBlockModel, from: number, to: number): Result<PartOp[]> {
  const range = checkRange(block, from, to);
  if (!range.ok) return range;
  if (from === to) return ok([]);
  const ops: PartOp[] = [];
  const removed = block.text.slice(from, to);
  if (removed.includes(BREAK)) {
    const first = paragraphAt(block, from);
    const survivor = paragraphAt(block, to);
    ops.push(...paragraphMarkOps(block.node, survivor.end, first.style, true));
  }
  ops.push({ op: 'text.delete', node: block.node, path: TEXT_CONTENT, from, to });
  return ok(ops);
}

/** Replace `[from, to)` with `text` (typing over a selection, IME commit, paste). */
export function replaceTextOps(block: TextBlockModel, from: number, to: number, text: string, style?: CharStyle): Result<PartOp[]> {
  const del = deleteTextOps(block, from, to);
  if (!del.ok) return del;
  // offsets after the delete: the insert lands at `from`; paragraph style comes from the paragraph at `from`
  const ins = insertTextOps(block, from, text, style);
  if (!ins.ok) return ins;
  return ok([...del.value, ...ins.value]);
}

function checkStyle(style: CharStyle): ReturnType<typeof TextStyleInvalidError> | undefined {
  for (const [key, value] of Object.entries(style)) {
    const problem = checkCharMark(key as CharMarkKey, value as JsonValue);
    if (problem !== undefined) return TextStyleInvalidError({ message: problem, details: { key } });
  }
  return undefined;
}

/** Set (or with `null` remove) one character mark on `[from, to)`. */
export function setCharMarkOps(block: TextBlockModel, from: number, to: number, key: CharMarkKey, value: JsonValue): Result<PartOp[]> {
  const range = checkRange(block, from, to);
  if (!range.ok) return range;
  const problem = checkCharMark(key, value);
  if (problem !== undefined) return err(TextStyleInvalidError({ message: problem, details: { key } }));
  if (from === to) return ok([]);
  return ok([{ op: 'text.mark', node: block.node, path: TEXT_CONTENT, from, to, key, value }]);
}

/** Apply a character style patch (several marks) to `[from, to)`; `null` fields remove marks. */
export function setCharStyleOps(block: TextBlockModel, from: number, to: number, patch: { readonly [K in CharMarkKey]?: JsonValue }): Result<PartOp[]> {
  const ops: PartOp[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const r = setCharMarkOps(block, from, to, key as CharMarkKey, value);
    if (!r.ok) return r;
    ops.push(...r.value);
  }
  return ok(ops);
}

/** Toggle a boolean mark: on unless every character of the range already has it. */
export function toggleCharMarkOps(block: TextBlockModel, from: number, to: number, key: 'bold' | 'italic' | 'underline' | 'strike'): Result<PartOp[]> {
  const all = block.paragraphs.flatMap((p) => p.runs).filter((r) => r.end > from && r.start < to && r.end > r.start);
  const on = all.length > 0 && all.every((r) => r.style[key] === true);
  return setCharMarkOps(block, from, to, key, on ? null : true);
}

/** Patch the style of every paragraph touching `[from, to]` (a caret touches its paragraph). */
export function setParagraphStyleOps(block: TextBlockModel, from: number, to: number, patch: { readonly [K in keyof ParagraphStyle]?: JsonValue }): Result<PartOp[]> {
  const range = checkRange(block, from, to);
  if (!range.ok) return range;
  const ops: PartOp[] = [];
  for (const p of block.paragraphs) {
    if (p.end < from || p.start > to) continue;
    for (const [fieldName, key] of PARA_FIELDS) {
      const value = patch[fieldName];
      if (value === undefined) continue;
      const problem = checkParagraphField(fieldName, value);
      if (problem !== undefined) return err(TextStyleInvalidError({ message: problem, details: { field: fieldName } }));
      ops.push({ op: 'text.mark', node: block.node, path: TEXT_CONTENT, from: p.end, to: p.end + 1, key, value });
    }
  }
  return ok(ops);
}

export interface CreateTextOptions {
  readonly node: NodeId;
  readonly parent: NodeId | null;
  readonly text?: string;
  /** Style of the whole initial text. */
  readonly style?: CharStyle;
  readonly paragraph?: ParagraphStyle;
  /** Lineage key (Auto Animate); defaults to the node id. */
  readonly matchKey?: string;
  /** Other components' properties (spatial, style; B1). */
  readonly props?: Readonly<Record<string, JsonValue>>;
}

/** A `create` op for a new text element (content ends with its paragraph break). */
export function createTextOps(options: CreateTextOptions): Result<PartOp[]> {
  const text = options.text ?? '';
  if (options.style !== undefined) {
    const bad = checkStyle(options.style);
    if (bad !== undefined) return err(bad);
  }
  const full = `${text}${BREAK}`;
  const spans: { start: number; end: number; marks: Record<string, JsonValue> }[] = [];
  if (options.style !== undefined && text.length > 0 && Object.keys(options.style).length > 0) spans.push({ start: 0, end: text.length, marks: options.style as Record<string, JsonValue> });
  const para = paragraphMarks(options.paragraph ?? {});
  for (let i = full.indexOf(BREAK); i >= 0; i = full.indexOf(BREAK, i + 1)) if (Object.keys(para).length > 0) spans.push({ start: i, end: i + 1, marks: para });
  return ok([
    {
      op: 'create',
      node: options.node,
      kind: TEXT_KIND,
      parent: options.parent,
      props: { ...options.props, [MATCH_KEY_PATH]: options.matchKey ?? options.node },
      texts: { [TEXT_CONTENT]: { text: full, spans } },
    },
  ]);
}

/** Copy a text element (rich content, props) under a new id; the match key is kept (Auto Animate lineage). */
export function duplicateTextOps(part: DocumentCRDTv2, node: NodeId, copy: NodeId, parent: NodeId | null): Result<PartOp[]> {
  const record = part.node(node);
  const rich = part.text(node, TEXT_CONTENT);
  if (record === undefined || record.kind !== TEXT_KIND || rich === undefined) return err(NotATextNodeError({ details: { node } }));
  const texts: Record<string, typeof rich> = {};
  for (const path of record.texts) {
    const value = part.text(node, path);
    if (value !== undefined) texts[path] = value;
  }
  return ok([{ op: 'create', node: copy, kind: TEXT_KIND, parent, props: { ...record.props, [MATCH_KEY_PATH]: record.props[MATCH_KEY_PATH] ?? node }, texts }]);
}

/** Stable anchors for a range (start sticks to the following char, end to the preceding one). */
export interface AnchoredRange {
  readonly start: TextAnchor;
  readonly end: TextAnchor;
}

export function anchorRange(part: DocumentCRDTv2, node: NodeId, start: number, end: number): Result<AnchoredRange> {
  const a = part.anchor(node, TEXT_CONTENT, start, 'before');
  const b = part.anchor(node, TEXT_CONTENT, end, end === start ? 'before' : 'after');
  if (a === undefined || b === undefined) return err(TextRangeError({ details: { node, start, end } }));
  return ok({ start: a, end: b });
}

export function resolveRange(part: DocumentCRDTv2, range: AnchoredRange): Result<readonly [number, number]> {
  const a = part.resolve(range.start);
  const b = part.resolve(range.end);
  if (a === undefined || b === undefined) return err(TextRangeError({ message: 'The anchored text is gone.' }));
  return ok([Math.min(a, b), Math.max(a, b)]);
}
