/**
 * Templates with slots (IF-5.8, UX §7 "Use template"). A slot is a marker on an existing element
 * — a text, an image or a colour — stored as the `slot` component (`slot.name`, `slot.accepts`,
 * `slot.target`, `slot.required`, `slot.maxChars`). Marking and unmarking are ordinary commits
 * (one undo step per actor). Using a template is "New document from milestone" with a transform
 * that writes each fill into its slot's target path, then drops the markers: the result is a plain,
 * detached document.
 *
 * Several elements may share a slot name (a headline repeated on two pages); one fill fills them
 * all. Slots with the same name must accept the same kind.
 */
import { err, ok, type Result } from '@staticflux/core';
import {
  type CanonicalNode,
  type CanonicalPart,
  defineComponent,
  type DocumentCRDTv2,
  field,
  type JsonObject,
  type JsonValue,
  type NodeId,
  type PartId,
  type PartOp,
  type PropertyPath,
} from '@staticflux/document/v2';
import type { Actor } from '@staticflux/stage';
import { RequiredSlotError, SlotFillError, SlotMarkError } from './errors.js';
import { createDocumentFromMilestone, type NewDocument, type NewDocumentRequest, type NewDocumentServiceOptions } from './new-document.js';
import { isAssetId } from './records.js';

export const SLOT_KINDS = ['text', 'image', 'color'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/** The `slot` component (add it to the app's component registry). */
export const SlotComponent = /* @__PURE__ */ defineComponent(
  'slot',
  { name: 'string', accepts: field.enum(SLOT_KINDS), target: 'string', required: 'bool', maxChars: 'i32' },
  { defaults: { required: false }, description: 'Marks an element as a template slot (IF-5.8).' },
);

const SLOT_COMPONENT = 'slot';
const SLOT_PATHS = ['slot.name', 'slot.accepts', 'slot.target', 'slot.required', 'slot.maxChars'] as const;

/**
 * Where each slot kind writes by default, and which node kinds it fits (empty: any kind). Data, so
 * the element package (B1) can retarget it without touching versioning.
 */
export const SLOT_TARGETS: Readonly<Record<SlotKind, { readonly path: PropertyPath; readonly kinds: readonly string[] }>> = {
  text: { path: 'text.content', kinds: ['text'] },
  image: { path: 'source.asset', kinds: ['image'] },
  color: { path: 'style.fill', kinds: [] },
};

export interface SlotSpec {
  readonly name: string;
  readonly accepts: SlotKind;
  /** Default: `SLOT_TARGETS[accepts].path`. Must be `component.field`. */
  readonly target?: PropertyPath;
  readonly required?: boolean;
  /** Text slots only. */
  readonly maxChars?: number;
}

/** A fill: text for text slots, an image asset id for image slots, a hex colour for colour slots. */
export type SlotFill = string;

/** Commits as an actor (structurally the stage `UndoService`, so marking is one undo step). */
export interface SlotWriter {
  commit(actor: Actor, label: string, changes: Readonly<Record<PartId, readonly PartOp[]>>): Result<unknown>;
}

/** The document being turned into a template (structurally a `DocumentRepo` `OpenDocument`). */
export interface SlotDocument {
  partIds(): readonly PartId[];
  loadedPart(id: PartId): DocumentCRDTv2 | undefined;
}

export interface TemplateSlot {
  readonly name: string;
  readonly accepts: SlotKind;
  readonly required: boolean;
  readonly maxChars?: number;
  readonly nodes: readonly { readonly part: PartId; readonly node: NodeId; readonly target: PropertyPath }[];
}

const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SLOT_NAME = /^[^\s].{0,63}$/u;

function isSlotKind(value: unknown): value is SlotKind {
  return typeof value === 'string' && (SLOT_KINDS as readonly string[]).includes(value);
}

function splitTarget(path: PropertyPath): readonly [string, string] | undefined {
  const parts = path.split('.');
  return parts.length === 2 && parts[0] !== '' && parts[1] !== '' ? [parts[0] as string, parts[1] as string] : undefined;
}

/** Mark an element of a loaded part as a slot (one commit, one undo step). */
export function markSlot(doc: SlotDocument, writer: SlotWriter, actor: Actor, request: { readonly part: PartId; readonly node: NodeId; readonly slot: SlotSpec }): Result<unknown> {
  const { slot } = request;
  const crdt = doc.loadedPart(request.part);
  const node = crdt?.node(request.node);
  const details = { part: request.part, node: request.node, slot: slot.name };
  if (crdt === undefined || node === undefined) return err(SlotMarkError({ message: 'The element to mark is not in a loaded part.', details }));
  const name = slot.name.trim();
  if (!SLOT_NAME.test(name)) return err(SlotMarkError({ message: 'A slot name must be 1–64 characters.', details }));
  if (!isSlotKind(slot.accepts)) return err(SlotMarkError({ message: `A slot accepts one of ${SLOT_KINDS.join(', ')}.`, details }));
  const fits = SLOT_TARGETS[slot.accepts].kinds;
  if (fits.length > 0 && !fits.includes(node.kind)) return err(SlotMarkError({ message: `A ${slot.accepts} slot fits ${fits.join(' or ')} elements, not "${node.kind}".`, details }));
  const target = slot.target ?? SLOT_TARGETS[slot.accepts].path;
  if (splitTarget(target) === undefined) return err(SlotMarkError({ message: 'A slot target is a `component.field` path.', details: { ...details, target } }));
  if (slot.maxChars !== undefined && (slot.accepts !== 'text' || !Number.isInteger(slot.maxChars) || slot.maxChars < 1)) {
    return err(SlotMarkError({ message: 'Only text slots take a character limit (a positive integer).', details }));
  }
  for (const id of doc.partIds()) {
    let clash: string | undefined;
    doc.loadedPart(id)?.forEachNode((other) => {
      if (other.id !== request.node && other.props['slot.name'] === name && other.props['slot.accepts'] !== slot.accepts) clash = String(other.props['slot.accepts']);
      return clash === undefined;
    });
    if (clash !== undefined) return err(SlotMarkError({ message: `Slot "${name}" already accepts ${clash} elsewhere in this template.`, details }));
  }
  const ops: PartOp[] = [
    { op: 'set', node: request.node, path: 'slot.name', value: name },
    { op: 'set', node: request.node, path: 'slot.accepts', value: slot.accepts },
    { op: 'set', node: request.node, path: 'slot.target', value: target },
    { op: 'set', node: request.node, path: 'slot.required', value: slot.required ?? false },
    { op: 'set', node: request.node, path: 'slot.maxChars', value: slot.maxChars ?? null },
  ];
  return writer.commit(actor, `Mark slot “${name}”`, { [request.part]: ops });
}

/** Remove a slot marker (one commit). */
export function unmarkSlot(writer: SlotWriter, actor: Actor, request: { readonly part: PartId; readonly node: NodeId }): Result<unknown> {
  return writer.commit(actor, 'Remove slot', { [request.part]: SLOT_PATHS.map((path) => ({ op: 'set', node: request.node, path, value: null }) as PartOp) });
}

interface SlotMarker {
  readonly name: string;
  readonly accepts: SlotKind;
  readonly target: PropertyPath;
  readonly required: boolean;
  readonly maxChars?: number;
}

function markerOf(node: CanonicalNode): SlotMarker | undefined {
  const slot = node.props[SLOT_COMPONENT] as Record<string, JsonValue> | undefined;
  if (slot === undefined || typeof slot['name'] !== 'string' || !isSlotKind(slot['accepts'])) return undefined;
  const accepts = slot['accepts'];
  const target = typeof slot['target'] === 'string' ? slot['target'] : SLOT_TARGETS[accepts].path;
  const maxChars = typeof slot['maxChars'] === 'number' ? slot['maxChars'] : undefined;
  return { name: slot['name'], accepts, target, required: slot['required'] === true, ...(maxChars === undefined ? {} : { maxChars }) };
}

/** Every slot in a set of canonical parts, grouped by name (sorted). */
export function listSlots(parts: readonly CanonicalPart[]): TemplateSlot[] {
  const byName = new Map<string, { accepts: SlotKind; required: boolean; maxChars?: number; nodes: { part: PartId; node: NodeId; target: PropertyPath }[] }>();
  for (const part of parts) {
    for (const node of part.nodes) {
      const marker = markerOf(node);
      if (marker === undefined) continue;
      const entry = byName.get(marker.name) ?? { accepts: marker.accepts, required: false, nodes: [] };
      entry.required ||= marker.required;
      if (marker.maxChars !== undefined) entry.maxChars = Math.min(entry.maxChars ?? Number.POSITIVE_INFINITY, marker.maxChars);
      entry.nodes.push({ part: part.part, node: node.id, target: marker.target });
      byName.set(marker.name, entry);
    }
  }
  return [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, e]) => ({ name, accepts: e.accepts, required: e.required, ...(e.maxChars === undefined ? {} : { maxChars: e.maxChars }), nodes: e.nodes }));
}

/** Check one fill against its slot (IF-VER-006). */
export function validateFill(slot: Pick<TemplateSlot, 'name' | 'accepts' | 'maxChars'>, fill: SlotFill): Result<void> {
  const details = { slot: slot.name, accepts: slot.accepts };
  if (typeof fill !== 'string') return err(SlotFillError({ details }));
  if (slot.accepts === 'image' && !isAssetId(fill)) return err(SlotFillError({ message: `Slot "${slot.name}" takes an image asset id (as_…).`, details }));
  if (slot.accepts === 'color' && !HEX_COLOR.test(fill)) return err(SlotFillError({ message: `Slot "${slot.name}" takes a hex colour such as #CF3D17.`, details }));
  if (slot.accepts === 'text' && slot.maxChars !== undefined && [...fill].length > slot.maxChars) {
    return err(SlotFillError({ message: `Slot "${slot.name}" takes at most ${slot.maxChars} characters.`, details: { ...details, maxChars: slot.maxChars } }));
  }
  return ok();
}

/** The stored value for a fill, shaped like the value it replaces (rich text keeps its first span's marks). */
function fillValue(accepts: SlotKind, fill: SlotFill, existing: JsonValue | undefined): JsonValue {
  const wrapped = typeof existing === 'object' && existing !== null && !Array.isArray(existing) && '$text' in existing;
  switch (accepts) {
    case 'text': {
      const previous = (wrapped ? (existing as JsonObject)['$text'] : existing) as { spans?: readonly { marks?: JsonObject }[] } | undefined;
      const marks = previous?.spans?.[0]?.marks;
      const value: JsonObject = { text: fill, spans: marks === undefined || fill.length === 0 ? [] : [{ start: 0, end: fill.length, marks }] };
      return wrapped ? { $text: value } : value;
    }
    case 'image':
      return { asset: fill };
    case 'color':
      return typeof existing === 'string' ? fill : { color: fill };
  }
}

/** Fill the slots of one canonical part and drop the markers (pure). */
export function fillPart(part: CanonicalPart, fills: Readonly<Record<string, SlotFill>>, options: { readonly keepSlots?: boolean } = {}): Result<CanonicalPart> {
  const nodes: CanonicalNode[] = [];
  for (const node of part.nodes) {
    const marker = markerOf(node);
    if (marker === undefined) {
      nodes.push(node);
      continue;
    }
    const props: Record<string, JsonObject> = { ...node.props };
    const fill = fills[marker.name];
    if (fill !== undefined) {
      const checked = validateFill(marker, fill);
      if (!checked.ok) return checked;
      const [component, fieldName] = splitTarget(marker.target) ?? [];
      if (component === undefined || fieldName === undefined) return err(SlotFillError({ message: `Slot "${marker.name}" has an invalid target.`, details: { slot: marker.name, target: marker.target } }));
      const values = { ...(props[component] ?? {}) } as Record<string, JsonValue>;
      values[fieldName] = fillValue(marker.accepts, fill, values[fieldName]);
      props[component] = values;
    }
    if (options.keepSlots !== true) delete props[SLOT_COMPONENT];
    nodes.push({ ...node, props });
  }
  return ok({ ...part, nodes });
}

/** Check fills against every slot: unknown names (IF-VER-006) and missing required slots (IF-VER-007). */
export function checkFills(slots: readonly TemplateSlot[], fills: Readonly<Record<string, SlotFill>>): Result<void> {
  const names = new Set(slots.map((s) => s.name));
  const unknown = Object.keys(fills).filter((name) => !names.has(name));
  if (unknown.length > 0) return err(SlotFillError({ message: `The template has no slot named ${unknown.map((n) => `"${n}"`).join(', ')}.`, details: { slot: unknown[0], unknown } }));
  for (const slot of slots) {
    const fill = fills[slot.name];
    if (fill === undefined) continue;
    const checked = validateFill(slot, fill);
    if (!checked.ok) return checked;
  }
  const missing = slots.filter((s) => s.required && (fills[s.name] ?? '').length === 0).map((s) => s.name);
  if (missing.length > 0) return err(RequiredSlotError({ details: { slots: missing } }));
  return ok();
}

export interface TemplateRequest extends Omit<NewDocumentRequest, 'transform' | 'check'> {
  readonly fills: Readonly<Record<string, SlotFill>>;
  /** Keep the slot markers in the new document (it becomes another template). Default false. */
  readonly keepSlots?: boolean;
}

/** "Use template": New document from milestone plus slot filling (IF-5.8). Nothing is written if a fill is invalid. */
export function createDocumentFromTemplate(options: NewDocumentServiceOptions, request: TemplateRequest, signal: AbortSignal): Promise<Result<NewDocument>> {
  const { fills, keepSlots, ...base } = request;
  const originals: CanonicalPart[] = [];
  return createDocumentFromMilestone(
    options,
    {
      ...base,
      transform: (part) => {
        originals.push(part);
        return fillPart(part, fills, keepSlots === undefined ? {} : { keepSlots });
      },
      check: () => checkFills(listSlots(originals), fills),
    },
    signal,
  );
}
