/**
 * Find and replace (B11c slice 3; STUDIO-UX-SPEC §9.1) as two capabilities the editor worker runs, so the find bar,
 * the command bar and agents reach the same thing: `instaflow/find` (writes nothing) and `instaflow/replace` (one undo
 * step across every page it touches, named `Replace '<a>' with '<b>'`).
 *
 * - **Text**: every text element's content, case-insensitive unless `matchCase`; a match never spans a paragraph
 *   break. Replacing keeps the marks of the run the match starts in (bold stays bold).
 * - **Font**: every text element using the family (runs with no font mark use the default face); replacing sets the
 *   new face on those runs (weight, size and the rest stay).
 * - **Colour**: solid fills and strokes, text colour marks and page backgrounds whose resolved colour (tokens through
 *   the kit) is the hex asked for; replacing writes the new hex in place of the paint.
 *
 * Scope: every page (default), this page, or the selection (and what it contains). Locked elements are matched and
 * listed; replacing skips them and counts them. Derived repeat instances are never matched (their source is).
 * Lit-free and pure over the document: the editor builds the env and the implementations (`implementFindReplace`).
 */
import { defineCapability, implementCapability, type AnyCapabilityImplementation, type RunContext, s } from '@staticflux/capabilities';
import { err, ok, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { P } from '../elements/components.js';
import { ActionNotApplicableError } from '../elements/errors.js';
import { colorToRgba, pageFills, rgbaToHex, tokenName } from '../elements/values.js';
import { type CharStyle, type FontRef, isTokenRef, TEXT_KIND } from '../text/model.js';
import { readTextBlock, replaceTextOps, setCharMarkOps, type TextBlockModel } from '../text/rich-text.js';
import type { StudioDocument } from './document.js';
import { pagePart } from './document.js';

export const FIND_KINDS = ['text', 'font', 'colour'] as const;
export type FindKind = (typeof FIND_KINDS)[number];
export const FIND_SCOPES = ['all', 'page', 'selection'] as const;
export type FindScope = (typeof FIND_SCOPES)[number];
/** Where in an element a match is. */
export type FindWhere = 'text' | 'font' | 'fill' | 'stroke' | 'text-colour' | 'background';

export interface FindQuery {
  readonly kind: FindKind;
  /** Text: the words; Font: the family name; Colour: `#rrggbb` (or any CSS colour). */
  readonly query: string;
  readonly matchCase?: boolean;
  readonly scope?: FindScope;
  /** The selection (scope `selection`). */
  readonly nodes?: readonly string[];
}

export interface FindMatch {
  /** Stable while the document does not change: `node:where:from`. */
  readonly id: string;
  readonly node: NodeId;
  readonly page: NodeId;
  readonly pageName: string;
  /** The element's display name (`Headline`, the text's first words). */
  readonly label: string;
  readonly where: FindWhere;
  /** Text matches: block offsets `[from, to)`. */
  readonly from?: number;
  readonly to?: number;
  readonly locked: boolean;
  readonly hidden: boolean;
}

/** What the find bar shows besides the matches (`No matches for 'flyer' in 5 pages`). */
export interface FindResult {
  readonly matches: readonly FindMatch[];
  readonly pages: number;
}

/** What replace wrote. */
export interface ReplaceResult {
  readonly ops: number;
  readonly replaced: number;
  /** Matches in locked elements (`2 locked, skipped`). */
  readonly skipped: number;
  readonly label: string;
}

/** What the scan reads (the editor's document; tests use a real one). */
export interface FindEnv {
  readonly document: Pick<StudioDocument, 'pages' | 'root' | 'view' | 'kit' | 'part' | 'undo'>;
  /** The page the canvas shows (scope `page`). */
  readonly page: () => NodeId | undefined;
  /** The family of runs with no font mark (the default face). */
  readonly defaultFamily: () => string;
  /** An element's display name. */
  readonly name: (node: NodeId) => string;
}

const nodesSchema = s.optional(s.array(s.string({ minLength: 1 }), { maxItems: 10_000, description: 'The selection, for scope "selection"' }));
const queryFields = {
  kind: s.enum(FIND_KINDS, { description: 'text, font or colour' }),
  query: s.string({ minLength: 1, maxLength: 500, description: 'Words (text), a family name (font) or a colour like #ff5c39 (colour)' }),
  matchCase: s.optional(s.boolean({ description: 'Text: match upper and lower case exactly (default: no)' })),
  scope: s.optional(s.enum(FIND_SCOPES, { description: 'all (every page, default), page (the open page) or selection' })),
  nodes: nodesSchema,
};
const matchSchema = s.object({
  id: s.string(),
  node: s.string(),
  page: s.string(),
  pageName: s.string(),
  label: s.string(),
  where: s.string(),
  from: s.optional(s.number({ integer: true })),
  to: s.optional(s.number({ integer: true })),
  locked: s.boolean(),
  hidden: s.boolean(),
});

export const FindCapability = defineCapability({
  id: 'instaflow/find',
  title: 'Find',
  description: 'Find text, a font or a colour on every page (or the open page, or the selection); writes nothing.',
  input: s.object(queryFields),
  output: s.object({ matches: s.array(matchSchema, { maxItems: 100_000 }), pages: s.number({ integer: true, min: 0 }) }),
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const ReplaceCapability = defineCapability({
  id: 'instaflow/replace',
  title: 'Replace',
  description: 'Replace what Find finds (all of it, or the matches named in `only`) as one undo step; locked elements are skipped and counted.',
  input: s.object({
    ...queryFields,
    replacement: s.string({ maxLength: 2000, description: 'Text: the new words; colour: the new colour; font: the new family’s label' }),
    font: s.optional(s.object({ font: s.string({ minLength: 8 }), family: s.optional(s.string()) }, { description: 'Font: the new face (a font choice’s value)' })),
    only: s.optional(s.array(s.string({ minLength: 1 }), { maxItems: 100_000, description: 'Match ids to replace (default: every match)' })),
  }),
  output: s.object({ ops: s.number({ integer: true, min: 0 }), replaced: s.number({ integer: true, min: 0 }), skipped: s.number({ integer: true, min: 0 }), label: s.string() }),
  requiresConfirmation: false,
  destructive: false,
  exposeToAgents: true,
});

export const FIND_CAPABILITIES = Object.freeze([FindCapability, ReplaceCapability]);

/** `#RRGGBB` of a CSS colour or a `@token` (through the kit); undefined when it is neither. Alpha is ignored. */
export function resolvedHex(value: unknown, kit: FindEnv['document']['kit']): string | undefined {
  const raw = typeof value === 'string' ? value : isTokenRef(value) ? `@${value.token}` : undefined;
  if (raw === undefined) return undefined;
  const token = tokenName(raw);
  const resolved = token === undefined ? raw : kit.token(token);
  const rgba = typeof resolved === 'string' ? colorToRgba(resolved) : undefined;
  return rgba === undefined ? undefined : rgbaToHex([rgba[0], rgba[1], rgba[2], 255]).toUpperCase();
}

const familyOf = (font: FontRef | undefined, fallback: string): string => (font === undefined ? fallback : isTokenRef(font) ? `@${font.token}` : (font.family ?? font.font));

/** Element nodes in reading order under `parent` (depth first, top-most last like the page draws). */
function walk(env: FindEnv, parent: NodeId, out: NodeId[]): void {
  for (const child of env.document.view.children(parent)) {
    if (env.document.view.isDerived(child)) continue;
    out.push(child);
    walk(env, child, out);
  }
}

const locked = (env: FindEnv, node: NodeId): boolean => {
  const lock = env.document.view.lockOf(node);
  return lock.position && lock.content;
};

/** Which pages and nodes a scope covers. */
function scopeNodes(env: FindEnv, q: FindQuery): readonly { readonly page: NodeId; readonly nodes: readonly NodeId[] }[] {
  const pages = env.document.pages.map((p) => p.id);
  const open = env.page();
  const scope = q.scope ?? 'all';
  const inPages = scope === 'page' && open !== undefined ? pages.filter((p) => p === open) : pages;
  const chosen = new Set<string>();
  if (scope === 'selection') {
    for (const n of q.nodes ?? []) {
      chosen.add(n);
      const under: NodeId[] = [];
      walk(env, n, under);
      for (const u of under) chosen.add(u);
    }
  }
  return inPages.map((page) => {
    const all: NodeId[] = [];
    walk(env, page, all);
    return { page, nodes: scope === 'selection' ? all.filter((n) => chosen.has(n)) : all };
  });
}

const pageName = (env: FindEnv, page: NodeId): string => {
  const name = env.document.root.prop(page, 'name');
  return typeof name === 'string' && name !== '' ? name : 'Page';
};

/** Every match of `q` (pure; nothing is written). */
export function findMatches(env: FindEnv, q: FindQuery): FindResult {
  const out: FindMatch[] = [];
  const kit = env.document.kit;
  const view = env.document.view;
  const wantHex = q.kind === 'colour' ? resolvedHex(q.query.trim(), kit) : undefined;
  const needle = q.query.includes('\n') ? '' : q.matchCase === true ? q.query : q.query.toLocaleLowerCase();
  const family = q.query.trim().toLocaleLowerCase();
  const covered = scopeNodes(env, q);
  for (const { page, nodes } of covered) {
    const part = env.document.part(page);
    const name = pageName(env, page);
    const base = (node: NodeId, where: FindWhere, from?: number, to?: number): FindMatch => ({
      id: `${node}:${where}:${from ?? 0}`,
      node,
      page,
      pageName: name,
      label: env.name(node),
      where,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      locked: locked(env, node),
      hidden: view.value(node, P.hidden) === true,
    });
    if (q.kind === 'colour' && wantHex !== undefined && (q.scope ?? 'all') !== 'selection') {
      if (pageFills(view, page).some((f) => solidHex(f, kit) === wantHex)) out.push(base(page, 'background'));
    }
    for (const node of nodes) {
      const kind = view.read(node)?.kind;
      const block = kind === TEXT_KIND && part !== undefined ? readTextBlock(part, node) : undefined;
      if (q.kind === 'text') {
        if (block?.ok !== true || needle === '') continue;
        const hay = q.matchCase === true ? block.value.text : block.value.text.toLocaleLowerCase();
        for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push(base(node, 'text', at, at + needle.length));
      } else if (q.kind === 'font') {
        if (block?.ok !== true || family === '') continue;
        const runs = block.value.paragraphs.flatMap((p) => p.runs);
        if (runs.some((r) => familyOf(r.style.font, env.defaultFamily()).toLocaleLowerCase() === family)) out.push(base(node, 'font'));
      } else if (wantHex !== undefined) {
        if ((view.value(node, P.fills) !== undefined && stack(view.value(node, P.fills)).some((f) => solidHex(f, kit) === wantHex))) out.push(base(node, 'fill'));
        if (stack(view.value(node, P.strokes)).some((f) => solidHex(f, kit) === wantHex)) out.push(base(node, 'stroke'));
        if (block?.ok === true && block.value.paragraphs.some((p) => p.runs.some((r) => resolvedHex(r.style.color, kit) === wantHex))) out.push(base(node, 'text-colour'));
      }
    }
  }
  return { matches: out, pages: covered.length };
}

const stack = (raw: JsonValue | undefined): readonly JsonValue[] => (Array.isArray(raw) ? raw : []);
const solidHex = (item: JsonValue, kit: FindEnv['document']['kit']): string | undefined =>
  typeof item === 'object' && item !== null && !Array.isArray(item) ? resolvedHex((item as Record<string, JsonValue>)['paint'], kit) : undefined;

/** The replace's undo label (`Replace 'Spring' with 'Autumn'`). */
export function replaceLabel(q: Pick<FindQuery, 'query'>, replacement: string): string {
  const cut = (t: string): string => (t.length > 24 ? `${t.slice(0, 23)}…` : t);
  return `Replace '${cut(q.query)}' with '${cut(replacement)}'`;
}

/** The ops of a replace, per part (pure). */
export function replacePlan(
  env: FindEnv,
  q: FindQuery,
  replacement: string,
  options: { readonly font?: FontRef; readonly only?: ReadonlySet<string> } = {},
): Result<{ readonly parts: Readonly<Record<string, PartOp[]>>; readonly replaced: number; readonly skipped: number }> {
  const { matches } = findMatches(env, q);
  const chosen = matches.filter((m) => options.only === undefined || options.only.has(m.id));
  const parts: Record<string, PartOp[]> = {};
  const push = (page: NodeId, ops: readonly PartOp[]): void => {
    (parts[pagePart(page)] ??= []).push(...ops);
  };
  const kit = env.document.kit;
  const view = env.document.view;
  const wantHex = q.kind === 'colour' ? resolvedHex(q.query.trim(), kit) : undefined;
  const newHex = q.kind === 'colour' ? resolvedHex(replacement.trim(), kit) : undefined;
  if (q.kind === 'colour' && newHex === undefined) return err(ActionNotApplicableError({ message: `“${replacement}” is not a colour.`, details: { needs: 'a colour like #ff5c39' } }));
  if (q.kind === 'font' && options.font === undefined) return err(ActionNotApplicableError({ message: 'Pick the new font.', details: { needs: 'a font' } }));
  let replaced = 0;
  let skipped = 0;
  // Text matches per node, last first: earlier offsets stay valid.
  const byNode = new Map<NodeId, FindMatch[]>();
  for (const m of chosen) {
    if (m.locked) {
      skipped += 1;
      continue;
    }
    byNode.set(m.node, [...(byNode.get(m.node) ?? []), m]);
  }
  for (const [node, list] of byNode) {
    const first = list[0] as FindMatch;
    const part = env.document.part(first.page);
    const block = part === undefined ? undefined : readTextBlock(part, node);
    const text = block?.ok === true ? block.value : undefined;
    for (const m of [...list].sort((a, b) => (b.from ?? 0) - (a.from ?? 0))) {
      const ops = matchOps(m, text, { q, replacement, font: options.font, wantHex, newHex: newHex ?? '', view, kit, defaultFamily: env.defaultFamily() });
      if (!ops.ok) return ops;
      if (ops.value.length === 0) continue;
      push(m.page, ops.value);
      replaced += 1;
    }
  }
  return ok({ parts, replaced, skipped });
}

interface OpsContext {
  readonly q: FindQuery;
  readonly replacement: string;
  readonly font: FontRef | undefined;
  readonly wantHex: string | undefined;
  readonly newHex: string;
  readonly view: FindEnv['document']['view'];
  readonly kit: FindEnv['document']['kit'];
  readonly defaultFamily: string;
}

/** The ops one match writes. */
function matchOps(m: FindMatch, block: TextBlockModel | undefined, c: OpsContext): Result<PartOp[]> {
  const restack = (path: string): PartOp[] => {
    const raw = stack(c.view.value(m.node, path));
    let changed = false;
    const next = raw.map((item) => {
      if (solidHex(item, c.kit) !== c.wantHex) return item;
      changed = true;
      return { ...(item as Record<string, JsonValue>), paint: c.newHex.toLowerCase() };
    });
    return changed ? [{ op: 'set', node: m.node, path, value: next as JsonValue }] : [];
  };
  const runs = (): readonly { readonly start: number; readonly end: number; readonly style: CharStyle }[] => block?.paragraphs.flatMap((p) => p.runs).filter((r) => r.end > r.start) ?? [];
  const WRITERS: Readonly<Record<FindWhere, () => Result<PartOp[]>>> = {
    text: () => {
      if (block === undefined || m.from === undefined || m.to === undefined) return ok([]);
      const style = runs().find((r) => r.start <= (m.from as number) && r.end > (m.from as number))?.style;
      return replaceTextOps(block, m.from, m.to, c.replacement, style);
    },
    font: () => {
      const family = c.q.query.trim().toLocaleLowerCase();
      const ops: PartOp[] = [];
      for (const r of runs()) {
        if (familyOf(r.style.font, c.defaultFamily).toLocaleLowerCase() !== family || block === undefined) continue;
        const set = setCharMarkOps(block, r.start, r.end, 'font', c.font as unknown as JsonValue);
        if (!set.ok) return set;
        ops.push(...set.value);
      }
      return ok(ops);
    },
    fill: () => ok(restack(P.fills)),
    stroke: () => ok(restack(P.strokes)),
    background: () => ok(restack(P.fills)),
    'text-colour': () => {
      const ops: PartOp[] = [];
      for (const r of runs()) {
        if (resolvedHex(r.style.color, c.kit) !== c.wantHex || block === undefined) continue;
        const set = setCharMarkOps(block, r.start, r.end, 'color', c.newHex.toLowerCase());
        if (!set.ok) return set;
        ops.push(...set.value);
      }
      return ok(ops);
    },
  };
  return WRITERS[m.where]();
}

/** Run a replace: one undo step over every part it touches. */
export function runReplace(env: FindEnv, actor: Actor, q: FindQuery, replacement: string, options: { readonly font?: FontRef; readonly only?: ReadonlySet<string> } = {}): Result<ReplaceResult> {
  const plan = replacePlan(env, q, replacement, options);
  if (!plan.ok) return plan;
  const label = replaceLabel(q, q.kind === 'font' ? replacement || familyOf(options.font, '') : replacement);
  const ops = Object.values(plan.value.parts).reduce((n, list) => n + list.length, 0);
  if (ops === 0) return ok({ ops: 0, replaced: 0, skipped: plan.value.skipped, label });
  const done = env.document.undo.commit(actor, label, plan.value.parts);
  return done.ok ? ok({ ops, replaced: plan.value.replaced, skipped: plan.value.skipped, label }) : done;
}

/** The two capabilities over the editor's document. */
export function implementFindReplace(env: FindEnv & { actorFor(run: RunContext): Result<Actor> }): readonly AnyCapabilityImplementation[] {
  return [
    implementCapability(FindCapability, (input) => ok(findMatches(env, input))),
    implementCapability(ReplaceCapability, (input, run) => {
      const actor = env.actorFor(run);
      if (!actor.ok) return actor;
      const font = input.font === undefined ? undefined : ({ font: input.font.font as `sha256:${string}`, ...(input.font.family === undefined ? {} : { family: input.font.family }) } as FontRef);
      return runReplace(env, actor.value, input, input.replacement, { ...(font === undefined ? {} : { font }), ...(input.only === undefined ? {} : { only: new Set(input.only) }) });
    }),
  ];
}
