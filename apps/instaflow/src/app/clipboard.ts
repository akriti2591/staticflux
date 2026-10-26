/**
 * Studio's clipboard as data (B11b, STUDIO-UX-SPEC §8.1): what Copy writes and how Paste reads it back. Lit-free and
 * pure over the editor's document, so the editor worker builds and applies payloads; main only moves them between the
 * system clipboard (`text/html` carries the payload, `text/plain` the names or text) and an in-memory fallback.
 *
 * - **Copy** serialises the selection as `create` ops of B1's `duplicate` over the base stage (document nodes only: a
 *   repeat's instances derive again), with rich text; the top-level ops name their source page and box.
 * - **Paste** re-mints every id, puts the top-level copies under the target (the page, or an entered container) and
 *   offsets them: on the source page while the source is still there, `+24, +24` per paste (stacking); on another page
 *   or document the same page coordinates; `inPlace` always the same coordinates. The pasted top level is selected.
 * - **Text** from other apps becomes an auto-width text element at the viewport centre.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import { duplicate, type ActionContext } from '../elements/actions.js';
import { P } from '../elements/components.js';
import { ActionNotApplicableError } from '../elements/errors.js';
import { DUPLICATE_STEP } from './studio-commands.js';

export const CLIPBOARD_FORMAT = 'instaflow/clipboard';
export const CLIPBOARD_VERSION = 1;
/** The attribute that carries a payload in `text/html` (base64 JSON on a span; other apps see the names). */
export const CLIPBOARD_HTML_ATTR = 'data-instaflow-clipboard';

export interface ClipboardPayload {
  readonly format: typeof CLIPBOARD_FORMAT;
  readonly version: typeof CLIPBOARD_VERSION;
  /** The document asset and page it came from (paste offsets only on that page). */
  readonly asset: string;
  readonly page: NodeId;
  /** Source ids of the top-level elements, in order (still on the page → stacking offset). */
  readonly sources: readonly NodeId[];
  /** `create` ops: the top level has `parent: null`; children name their (payload) parent. */
  readonly ops: readonly PartOp[];
  /** Plain text for other apps (text content, or the names). */
  readonly text: string;
}

const isCreate = (op: PartOp): op is Extract<PartOp, { op: 'create' }> => op.op === 'create';

/** Serialise `nodes` (document nodes; derived ones are skipped). */
export function copyPayload(ctx: ActionContext, nodes: readonly NodeId[], where: { readonly asset: string; readonly page: NodeId }, text: (node: NodeId) => string | undefined): Result<ClipboardPayload> {
  const copied = duplicate(ctx, nodes);
  if (!copied.ok) return copied;
  const tops = new Set(nodes.flatMap((n) => copied.value.copies.get(n) ?? []));
  const ops = copied.value.ops.filter(isCreate).map((op) => (tops.has(op.node) ? { ...op, parent: null, position: undefined } : op)).map((op) => {
    if (op.position !== undefined) return op;
    const { position: _drop, ...rest } = op;
    void _drop;
    return rest as PartOp;
  });
  const names = nodes.map((n) => text(n) ?? String(ctx.stage.value(n, 'name') ?? '')).filter((x) => x !== '');
  return ok({ format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, ...where, sources: [...nodes], ops, text: names.join('\n') });
}

/** Read a payload back (anything else is not ours). */
export function parsePayload(value: unknown): ClipboardPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const p = value as Partial<ClipboardPayload>;
  if (p.format !== CLIPBOARD_FORMAT || p.version !== CLIPBOARD_VERSION || !Array.isArray(p.ops) || !Array.isArray(p.sources) || typeof p.page !== 'string') return undefined;
  return p as ClipboardPayload;
}

export interface PasteTarget {
  readonly asset: string;
  readonly page: NodeId;
  /** Where the top level goes (the page, or an entered container). */
  readonly parent: NodeId;
  /** Does a source node still exist on the target page? */
  readonly exists: (node: NodeId) => boolean;
  readonly newId: () => NodeId;
  /** How many times this payload was pasted here already (stacking). */
  readonly count: number;
  /** Paste in place: same coordinates, always. */
  readonly inPlace: boolean;
}

/** The offset of the next paste (STUDIO §8.1). */
export function pasteOffset(payload: ClipboardPayload, target: Pick<PasteTarget, 'asset' | 'page' | 'exists' | 'count' | 'inPlace'>): readonly [number, number] {
  if (target.inPlace) return [0, 0];
  const samePage = payload.asset === target.asset && payload.page === target.page && payload.sources.some((n) => target.exists(n));
  if (!samePage) return [0, 0];
  const k = target.count + 1;
  return [DUPLICATE_STEP[0] * k, DUPLICATE_STEP[1] * k];
}

const num = (v: JsonValue | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The ops that paste `payload` at `target`, and the new top-level ids (to select). */
export function pasteOps(payload: ClipboardPayload, target: PasteTarget): Result<{ readonly ops: readonly PartOp[]; readonly select: readonly NodeId[] }> {
  const creates = payload.ops.filter(isCreate);
  if (creates.length === 0) return err(ActionNotApplicableError({ message: 'The clipboard holds nothing to paste.', details: { needs: 'copied elements' } }));
  const ids = new Map(creates.map((op) => [op.node, target.newId()] as const));
  const [dx, dy] = pasteOffset(payload, target);
  const select: NodeId[] = [];
  const ops = creates.map((op): PartOp => {
    const node = ids.get(op.node) as NodeId;
    const top = op.parent === null;
    if (top) select.push(node);
    const props = { ...(op.props ?? {}) };
    if (top) {
      props[P.x] = num(props[P.x]) + dx;
      props[P.y] = num(props[P.y]) + dy;
    }
    // The match key stays (copies of one element share lineage); a new id everywhere else.
    return { ...op, node, parent: top ? target.parent : (ids.get(op.parent as NodeId) ?? (op.parent as NodeId)), props };
  });
  return ok({ ops, select });
}

/** Encode / decode a payload for `text/html` (base64 of UTF-8 JSON on a span; the visible text is `payload.text`). */
export function payloadToHtml(payload: ClipboardPayload): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const escape = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  return `<span ${CLIPBOARD_HTML_ATTR}="${btoa(binary)}">${escape(payload.text)}</span>`;
}

export function payloadFromHtml(html: string): ClipboardPayload | undefined {
  const m = new RegExp(`${CLIPBOARD_HTML_ATTR}="([A-Za-z0-9+/=]+)"`).exec(html);
  if (m === null) return undefined;
  try {
    const binary = atob(m[1] as string);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return parsePayload(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } catch {
    return undefined;
  }
}
