/**
 * The inspector's appearance sections (B11b, APPEARANCE-TRANSFORM-UX-SPEC §2.1–§2.7): the Fill, Stroke and Effects
 * **stacks** (rows top first: swatch · summary · opacity · eye · ×, a second line with the row's fields when expanded
 * or in Pro, `+ Add ▾`), the gradient editor in the swatch's popover (type, stops, angle, reverse), Corners and Layer.
 * Templates only: every edit is an `AppearanceEdit` (one undo step each) or, for a multi-selection, a scene action on
 * every element. The host element (`<if-inspector>`) owns the state (expanded rows, recent colours) through `PaintHost`.
 */
import type { ColorChangeDetail, DocumentColor } from '@staticflux/kit/color-popover';
import { arrowLeftRightIcon } from '@staticflux/kit/icons/arrow-left-right';
import { chevronDownIcon } from '@staticflux/kit/icons/chevron-down';
import { chevronUpIcon } from '@staticflux/kit/icons/chevron-up';
import { eyeIcon } from '@staticflux/kit/icons/eye';
import { eyeOffIcon } from '@staticflux/kit/icons/eye-off';
import { imageIcon } from '@staticflux/kit/icons/image';
import { linkIcon } from '@staticflux/kit/icons/link';
import { plusIcon } from '@staticflux/kit/icons/plus';
import { rotateCwIcon } from '@staticflux/kit/icons/rotate-cw';
import { unlinkIcon } from '@staticflux/kit/icons/unlink';
import { xIcon } from '@staticflux/kit/icons/x';
import type { NumberChangeDetail } from '@staticflux/kit/number-field';
import type { JsonValue } from '@staticflux/document/v2';
import { html, nothing, type TemplateResult } from 'lit';
import type { PaintSummary } from '../app/scene-summary.js';
import { type BlendModeName, CORNER_PATHS, P } from '../elements/components.js';
import type { AppearanceEdit, AppearanceModel, StackName } from '../elements/inspector.js';
import type { EffectValue, GradientStopValue, PaintValue } from '../elements/values.js';
import { CLEAN_POP_COLOR_PALETTE } from '../theme/palette.js';
import {
  BLEND_GROUPS,
  BLEND_LABELS,
  DASH_LABELS,
  DASH_PRESETS,
  dashPatch,
  dashPresetOf,
  EFFECT_PRESETS,
  effectPreset,
  effectRowSummary,
  GRADIENT_KINDS,
  GRADIENT_LABELS,
  type GradientKind,
  gradientAngle,
  gradientFrom,
  isGradient,
  leadColor,
  paintKind,
  paintRowSummary,
  reversed,
  STROKE_CAP_LABELS,
  STROKE_JOIN_LABELS,
  STROKE_POSITION_LABELS,
  strokeRowSummary,
  withAngle,
  withKind,
  withStop,
  withStopAdded,
  withStopRemoved,
} from './inspector-model.js';

export const paintMessages = Object.freeze({
  fill: 'Fill',
  stroke: 'Stroke',
  effects: 'Effects',
  corners: 'Corners',
  layer: 'Layer',
  add: 'Add',
  addFill: 'Add fill',
  addStroke: 'Add stroke',
  addEffect: 'Add effect',
  colour: 'Colour',
  gradient: 'Gradient',
  noFill: 'No fill',
  noStroke: 'No stroke',
  noEffects: 'No effects',
  mixedFills: 'Mixed fills',
  mixedStrokes: 'Mixed strokes',
  replaceAll: 'Replace all',
  opacity: 'Opacity',
  blend: 'Blend',
  show: 'Show',
  hide: 'Hide',
  remove: 'Remove',
  moveUp: 'Move up',
  moveDown: 'Move down',
  width: 'Width',
  position: 'Position',
  dash: 'Dash',
  cap: 'Cap',
  join: 'Join',
  miter: 'Miter limit',
  radius: 'Radius',
  perCorner: 'Per-corner radii',
  linkCorners: 'One radius for all corners',
  smooth: 'Smooth',
  corner: ['Top left', 'Top right', 'Bottom right', 'Bottom left'] as const,
  x: 'X',
  y: 'Y',
  blur: 'Blur',
  spread: 'Spread',
  gradientType: 'Gradient type',
  stops: 'Stops',
  stop: (n: number) => `Stop ${n}`,
  stopPosition: (n: number) => `Stop ${n} position`,
  addStop: 'Add stop',
  removeStop: 'Remove stop',
  angle: 'Angle',
  rotate45: 'Rotate 45°',
  reverse: 'Reverse',
  toSolid: 'Use a solid colour',
  fromBrand: 'From brand',
  limit: (what: string) => `Up to 16 ${what}`,
  image: 'Image',
});

/** The most items a stack holds (the model's limit). */
export const MAX_STACK_ITEMS = 16;

/** What the sections need from the element that renders them. */
export interface PaintHost {
  readonly pro: boolean;
  readonly documentColors: readonly DocumentColor[];
  readonly recent: readonly string[];
  /** Record a committed colour in the recents, then apply the paint value. */
  commitColor(detail: ColorChangeDetail, apply: (paint: string) => void): void;
  /** Row second lines the person opened (`fills:2`). */
  isExpanded(key: string): boolean;
  toggleRow(key: string): void;
  /** Resolve `@token` → hex (undefined: not in the kit). */
  resolve(token: string): string | undefined;
}

type Item = Readonly<Record<string, JsonValue>>;
const asItem = (v: unknown): Item => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Item) : {});
const num = (v: JsonValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const numberField = (label: string, value: number | undefined, commit: (n: number) => void, o: { min?: number; max?: number; unit?: string; step?: number; mixed?: boolean; hidden?: boolean; wrap?: string } = {}): TemplateResult =>
  html`<sf-number-field
    label=${label}
    ?label-hidden=${o.hidden === true}
    .value=${o.mixed === true ? undefined : value}
    ?mixed=${o.mixed === true}
    min=${o.min ?? nothing}
    max=${o.max ?? nothing}
    step=${o.step ?? nothing}
    unit=${o.unit ?? ''}
    wrap=${o.wrap ?? nothing}
    @sf-change=${(e: CustomEvent<NumberChangeDetail>) => {
      if (e.detail.value !== undefined) commit(e.detail.value);
    }}
  ></sf-number-field>`;

const choiceMenu = <V extends string>(label: string, current: V, labels: Readonly<Record<V, string>>, pick: (v: V) => void): TemplateResult =>
  html`<sf-menu label=${label} @sf-select=${(e: CustomEvent<{ value: V }>) => pick(e.detail.value)}>
    <sf-button slot="trigger" size="sm" variant="ghost" aria-label=${`${label}: ${labels[current]}`}>${labels[current]} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
    ${(Object.keys(labels) as V[]).map((v) => html`<sf-menu-item type="radio" value=${v} ?checked=${v === current}>${labels[v]}</sf-menu-item>`)}
  </sf-menu>`;

/** The grouped Blend menu (16 modes, APPEARANCE §2.1). */
export function blendMenu(label: string, current: BlendModeName | 'mixed', pick: (mode: BlendModeName) => void): TemplateResult {
  const shown = current === 'mixed' ? 'Mixed' : BLEND_LABELS[current];
  return html`<sf-menu label=${label} @sf-select=${(e: CustomEvent<{ value: BlendModeName }>) => pick(e.detail.value)}>
    <sf-button slot="trigger" size="sm" variant="ghost" aria-label=${`${label}: ${shown}`}>${shown} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
    ${BLEND_GROUPS.map(
      ([group, modes]) => html`<sf-menu-group label=${group}>${modes.map((m) => html`<sf-menu-item type="radio" value=${m} ?checked=${m === current}>${BLEND_LABELS[m]}</sf-menu-item>`)}</sf-menu-group>`,
    )}
  </sf-menu>`;
}

/** A swatch that opens the shared colour popover (solid paints; `label` names both). */
export function colorSwatch(host: PaintHost, label: string, color: string | undefined, apply: (paint: string) => void, o: { mixed?: boolean; unresolved?: boolean; token?: string } = {}): TemplateResult {
  const hex = color === undefined ? '' : color.slice(0, 7);
  return html`<sf-popover label=${`${label} colour`} outside="pass">
    <sf-icon-button slot="trigger" size="sm" variant="ghost" label=${label}><sf-swatch color=${color ?? '#00000000'} ?unresolved=${o.unresolved === true || o.mixed === true}></sf-swatch></sf-icon-button>
    <sf-color-popover
      label=${`${label} colour`}
      value=${o.mixed === true ? '' : hex}
      ?mixed=${o.mixed === true}
      token=${o.token ?? nothing}
      ?unresolved=${o.unresolved === true}
      ?custom-open=${host.pro}
      ?captions=${host.pro}
      .documentColors=${host.documentColors}
      .palette=${CLEAN_POP_COLOR_PALETTE}
      .recent=${host.recent}
      @sf-change=${(e: CustomEvent<ColorChangeDetail>) => host.commitColor(e.detail, apply)}
    ></sf-color-popover>
  </sf-popover>`;
}

/** The swatch of any paint: a solid opens the colour popover; a gradient opens the gradient editor. */
function paintSwatch(host: PaintHost, label: string, paint: JsonValue | undefined, set: (paint: JsonValue) => void): TemplateResult {
  const kind = paintKind(paint);
  if (kind === 'image') {
    return html`<span class="thumb" aria-hidden="true"><sf-icon .icon=${imageIcon} size="16"></sf-icon></span>`;
  }
  if (isGradient(paint)) return gradientSwatch(host, label, paint, set);
  const value = typeof paint === 'string' ? paint : '#00000000';
  const token = value.startsWith('@') ? value.slice(1) : undefined;
  const resolved = token === undefined ? value : host.resolve(value);
  return colorSwatch(host, label, resolved, (p) => set(p), { ...(token === undefined ? {} : { token }), unresolved: token !== undefined && resolved === undefined });
}

const PAINT_KIND_LABELS = Object.freeze({ solid: 'Solid', linear: 'Linear', radial: 'Radial', conic: 'Conic' } as const);

/** The row's paint kind (the popover tabs Solid · Gradient, APPEARANCE §2.2): switching converts the paint. */
function paintKindMenu(host: PaintHost, label: string, paint: JsonValue | undefined, set: (paint: JsonValue) => void): TemplateResult | typeof nothing {
  const kind = paintKind(paint);
  if (kind === 'image') return nothing;
  const convert = (to: keyof typeof PAINT_KIND_LABELS): void => {
    if (to === kind) return;
    if (to === 'solid') set((leadColor(paint) ?? '#16151A') as JsonValue);
    else if (isGradient(paint)) set(withKind(paint, to) as unknown as JsonValue);
    else {
      const color = typeof paint === 'string' ? (host.resolve(paint) ?? paint) : '#16151A';
      set(gradientFrom(color, to) as unknown as JsonValue);
    }
  };
  return choiceMenu(`${label} kind`, kind, PAINT_KIND_LABELS, convert);
}

type Gradient = Extract<PaintValue, { readonly stops: readonly GradientStopValue[] }>;

/** The gradient editor (APPEARANCE §2.3.1) in the swatch's popover: type, stops (colour, position, add, remove), angle, reverse. */
function gradientSwatch(host: PaintHost, label: string, paint: Gradient, set: (paint: JsonValue) => void): TemplateResult {
  const put = (next: Gradient): void => set(next as unknown as JsonValue);
  const css = `linear-gradient(90deg, ${paint.stops.map((s) => `${host.resolve(s.color) ?? s.color} ${Math.round(s.offset * 100)}%`).join(', ')})`;
  return html`<sf-popover label=${`${label} gradient`} outside="pass">
    <sf-icon-button slot="trigger" size="sm" variant="ghost" label=${label}><span class="gradient-thumb" style=${`background:${css}`}></span></sf-icon-button>
    <div class="gradient-editor">
      <sf-segmented
        label=${paintMessages.gradientType}
        .options=${GRADIENT_KINDS.map((k) => ({ value: k, label: GRADIENT_LABELS[k] }))}
        .value=${paint.kind}
        @sf-change=${(e: CustomEvent<{ value: GradientKind }>) => put(withKind(paint, e.detail.value))}
      ></sf-segmented>
      <div class="strip" style=${`background:${css}`} aria-hidden="true"></div>
      <div class="stops" role="group" aria-label=${paintMessages.stops}>
        ${paint.stops.map(
          (stop, i) => html`<div class="stop">
            ${colorSwatch(host, paintMessages.stop(i + 1), host.resolve(stop.color) ?? stop.color, (c) => put(withStop(paint, i, { color: c })))}
            ${numberField(paintMessages.stopPosition(i + 1), Math.round(stop.offset * 100), (n) => put(withStop(paint, i, { offset: n / 100 })), { min: 0, max: 100, unit: '%', hidden: true })}
            <sf-icon-button size="sm" variant="ghost" label=${`${paintMessages.removeStop} ${i + 1}`} ?disabled=${paint.stops.length <= 2} @click=${() => put(withStopRemoved(paint, i))}><sf-icon .icon=${xIcon} size="14"></sf-icon></sf-icon-button>
          </div>`,
        )}
        <sf-button size="sm" variant="ghost" @click=${() => put(withStopAdded(paint, 0.5))}><sf-icon .icon=${plusIcon} size="14"></sf-icon> ${paintMessages.addStop}</sf-button>
      </div>
      <div class="row">
        ${paint.kind === 'radial'
          ? nothing
          : html`${numberField(paintMessages.angle, gradientAngle(paint), (n) => put(withAngle(paint, n)), { unit: '°', min: 0, max: 359 })}
              <sf-icon-button size="sm" variant="ghost" label=${paintMessages.rotate45} @click=${() => put(withAngle(paint, gradientAngle(paint) + 45))}><sf-icon .icon=${rotateCwIcon} size="14"></sf-icon></sf-icon-button>`}
        <sf-icon-button size="sm" variant="ghost" label=${paintMessages.reverse} @click=${() => put(reversed(paint))}><sf-icon .icon=${arrowLeftRightIcon} size="14"></sf-icon></sf-icon-button>
      </div>
      <sf-button size="sm" variant="ghost" @click=${() => set((leadColor(paint) ?? '#16151A') as JsonValue)}>${paintMessages.toSolid}</sf-button>
    </div>
  </sf-popover>`;
}

/** One stack row: swatch · summary (expands) · opacity · eye · × ; the second line when expanded or in Pro. */
function stackRow(host: PaintHost, o: {
  readonly stack: StackName;
  readonly index: number;
  readonly count: number;
  readonly item: Item;
  readonly name: string;
  readonly swatch: TemplateResult;
  readonly summary: { readonly title: string; readonly detail?: string };
  readonly trailing?: TemplateResult;
  readonly detail?: TemplateResult | typeof nothing;
  readonly edit: (e: AppearanceEdit) => void;
  readonly opacity?: boolean;
}): TemplateResult {
  const key = `${o.stack}:${o.index}`;
  const open = host.pro || host.isExpanded(key);
  const hidden = o.item['visible'] === false;
  const onKey = (e: KeyboardEvent): void => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const to = o.index + (e.key === 'ArrowUp' ? 1 : -1);
    if (to < 0 || to >= o.count) return;
    e.preventDefault();
    o.edit({ op: 'move', stack: o.stack, from: o.index, to });
  };
  return html`<div class="stack-row" ?data-hidden=${hidden} @keydown=${onKey}>
    <div class="line">
      ${o.swatch}
      <button type="button" class="summary" aria-expanded=${open ? 'true' : 'false'} aria-label=${`${o.name}: ${o.summary.title}`} @click=${() => host.toggleRow(key)}>
        <span>${o.summary.title}</span>${o.summary.detail === undefined ? nothing : html`<span class="mono muted">${o.summary.detail}</span>`}
      </button>
      ${o.trailing ?? nothing}
      ${o.opacity === false ? nothing : html`<span class="opacity">${numberField(`${o.name} ${paintMessages.opacity.toLowerCase()}`, Math.round(num(o.item['opacity'], 1) * 100), (n) => o.edit({ op: 'update', stack: o.stack, index: o.index, patch: { opacity: Math.max(0, Math.min(100, n)) / 100 } }), { min: 0, max: 100, unit: '%', hidden: true })}</span>`}
      <sf-icon-button size="sm" variant="ghost" label=${`${hidden ? paintMessages.show : paintMessages.hide} ${o.name.toLowerCase()}`} .pressed=${hidden} @click=${() => o.edit({ op: 'toggle', stack: o.stack, index: o.index })}
        ><sf-icon .icon=${hidden ? eyeOffIcon : eyeIcon} size="14"></sf-icon
      ></sf-icon-button>
      <sf-icon-button size="sm" variant="ghost" label=${`${paintMessages.remove} ${o.name.toLowerCase()}`} @click=${() => o.edit({ op: 'remove', stack: o.stack, index: o.index })}><sf-icon .icon=${xIcon} size="14"></sf-icon></sf-icon-button>
    </div>
    ${open
      ? html`<div class="second">
          ${o.detail ?? nothing}
          <span class="reorder">
            <sf-icon-button size="sm" variant="ghost" label=${`${paintMessages.moveUp} ${o.name.toLowerCase()}`} shortcut="Alt+ArrowUp" ?disabled=${o.index >= o.count - 1} @click=${() => o.edit({ op: 'move', stack: o.stack, from: o.index, to: o.index + 1 })}
              ><sf-icon .icon=${chevronUpIcon} size="14"></sf-icon
            ></sf-icon-button>
            <sf-icon-button size="sm" variant="ghost" label=${`${paintMessages.moveDown} ${o.name.toLowerCase()}`} shortcut="Alt+ArrowDown" ?disabled=${o.index === 0} @click=${() => o.edit({ op: 'move', stack: o.stack, from: o.index, to: o.index - 1 })}
              ><sf-icon .icon=${chevronDownIcon} size="14"></sf-icon
            ></sf-icon-button>
          </span>
        </div>`
      : nothing}
  </div>`;
}

const addMenu = (label: string, full: boolean, what: string, items: TemplateResult, pick: (value: string) => void): TemplateResult =>
  html`<sf-menu label=${label} @sf-select=${(e: CustomEvent<{ value: string }>) => pick(e.detail.value)}>
    <sf-button slot="trigger" size="sm" variant="ghost" ?disabled=${full}><sf-icon .icon=${plusIcon} size="14"></sf-icon> ${paintMessages.add} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
    ${items} ${full ? html`<sf-menu-item value="" disabled>${paintMessages.limit(what)}</sf-menu-item>` : nothing}
  </sf-menu>`;

/** `+ Add ▾` paints: Colour · Gradient ▸ (Linear · Radial · Conic); `solidOnly` (text) lists Colour only. */
function addPaintMenu(label: string, count: number, what: string, add: (paint: PaintValue) => void, base: string, solidOnly = false): TemplateResult {
  const pick = (value: string): void => {
    if (value === 'colour') add(count > 0 ? '#D9D9D9' : base);
    else if ((GRADIENT_KINDS as readonly string[]).includes(value)) add(gradientFrom(base, value as GradientKind));
  };
  return addMenu(
    label,
    count >= MAX_STACK_ITEMS,
    what,
    html`<sf-menu-item value="colour">${paintMessages.colour}</sf-menu-item>
      ${solidOnly
        ? nothing
        : html`<sf-menu-item value="gradient">${paintMessages.gradient}</sf-menu-item>
            <sf-menu slot="submenu" label=${paintMessages.gradient}>${GRADIENT_KINDS.map((k) => html`<sf-menu-item value=${k}>${GRADIENT_LABELS[k]}</sf-menu-item>`)}</sf-menu>`}`,
    pick,
  );
}

/** The Fill stack of one element (or the page's Background, `page`). */
export function fillStack(host: PaintHost, model: AppearanceModel, edit: (e: AppearanceEdit) => void, o: { readonly name?: string; readonly page?: boolean } = {}): TemplateResult {
  const name = o.name ?? paintMessages.fill;
  const count = model.fills.length;
  const top = model.fills.at(-1);
  const base = leadColor(top?.paint as JsonValue | undefined) ?? '#FF5C39';
  const rows = [...model.fills.keys()].reverse().map((index) => {
    const item = asItem(model.fills[index]);
    const paint = item['paint'];
    const set = (p: JsonValue): void => edit({ op: 'update', stack: 'fills', index, patch: { paint: p } });
    const fit = asItem(paint)['fit'];
    const rowName = count > 1 ? `${name} ${count - index}` : name;
    return stackRow(host, {
      stack: 'fills',
      index,
      count,
      item,
      name: rowName,
      swatch: paintSwatch(host, rowName, paint, set),
      summary: paintRowSummary(paint, (t) => host.resolve(t)),
      detail: html`${o.page === true ? nothing : paintKindMenu(host, rowName, paint, set)}${paintKind(paint) === 'image'
        ? choiceMenu(`${rowName} fit`, (typeof fit === 'string' ? fit : 'cover') as 'cover' | 'contain' | 'stretch' | 'tile', { cover: 'Fill', contain: 'Fit', stretch: 'Stretch', tile: 'Tile' }, (f) => set({ ...asItem(paint), fit: f } as JsonValue))
        : nothing}
      ${blendMenu(`${rowName} ${paintMessages.blend.toLowerCase()}`, (item['blend'] as BlendModeName | undefined) ?? 'normal', (m) => edit({ op: 'update', stack: 'fills', index, patch: { blend: m } }))}`,
      edit,
    });
  });
  return html`${count === 0 ? html`<p class="muted">${paintMessages.noFill}</p>` : rows}
    ${addPaintMenu(o.page === true ? `${paintMessages.add} ${name.toLowerCase()}` : paintMessages.addFill, count, 'fills', (paint) => edit({ op: 'add', stack: 'fills', item: { paint } }), base, o.page === true)}`;
}

/** The Stroke stack of one element (APPEARANCE §2.5). */
export function strokeStack(host: PaintHost, model: AppearanceModel, edit: (e: AppearanceEdit) => void, o: { readonly sides?: boolean } = {}): TemplateResult {
  const count = model.strokes.length;
  const rows = [...model.strokes.keys()].reverse().map((index) => {
    const item = asItem(model.strokes[index]);
    const update = (patch: Readonly<Record<string, JsonValue>>): void => edit({ op: 'update', stack: 'strokes', index, patch });
    const name = count > 1 ? `${paintMessages.stroke} ${count - index}` : paintMessages.stroke;
    const width = num(item['width'], 1);
    const dash = dashPresetOf(item);
    const sides = Array.isArray(item['sides']) ? (item['sides'] as number[]) : undefined;
    return stackRow(host, {
      stack: 'strokes',
      index,
      count,
      item,
      name,
      swatch: paintSwatch(host, name, item['paint'], (p) => update({ paint: p })),
      summary: strokeRowSummary(item, (t) => host.resolve(t)),
      trailing: html`<span class="width">${numberField(`${name} ${paintMessages.width.toLowerCase()}`, width, (n) => update({ width: Math.max(0.5, Math.min(1000, n)) }), { min: 0.5, max: 1000, unit: 'px', hidden: true, step: 0.5 })}</span>`,
      detail: html`${paintKindMenu(host, name, item['paint'], (p) => update({ paint: p }))}${choiceMenu(`${name} ${paintMessages.position.toLowerCase()}`, ((item['align'] as string | undefined) ?? 'center') as keyof typeof STROKE_POSITION_LABELS, STROKE_POSITION_LABELS, (v) => update({ align: v }))}
        <sf-menu label=${`${name} ${paintMessages.dash.toLowerCase()}`} @sf-select=${(e: CustomEvent<{ value: (typeof DASH_PRESETS)[number] }>) => update(dashPatch(e.detail.value, width))}>
          <sf-button slot="trigger" size="sm" variant="ghost" aria-label=${`${name} ${paintMessages.dash.toLowerCase()}: ${DASH_LABELS[dash]}`}>${DASH_LABELS[dash]} <sf-icon .icon=${chevronDownIcon} size="14"></sf-icon></sf-button>
          ${DASH_PRESETS.map((d) => html`<sf-menu-item type="radio" value=${d} ?checked=${d === dash}>${DASH_LABELS[d]}</sf-menu-item>`)}
        </sf-menu>
        ${choiceMenu(`${name} ${paintMessages.cap.toLowerCase()}`, ((item['cap'] as string | undefined) ?? 'butt') as keyof typeof STROKE_CAP_LABELS, STROKE_CAP_LABELS, (v) => update({ cap: v }))}
        ${choiceMenu(`${name} ${paintMessages.join.toLowerCase()}`, ((item['join'] as string | undefined) ?? 'miter') as keyof typeof STROKE_JOIN_LABELS, STROKE_JOIN_LABELS, (v) => update({ join: v }))}
        ${host.pro ? numberField(`${name} ${paintMessages.miter.toLowerCase()}`, num(item['miter'], 4), (n) => update({ miter: Math.max(1, n) }), { min: 1, max: 100 }) : nothing}
        ${o.sides === true
          ? html`<sf-icon-button size="sm" variant="ghost" label=${`${name}: per-side widths`} .pressed=${sides !== undefined} @click=${() => update({ sides: sides === undefined ? [width, width, width, width] : null })}
              ><sf-icon .icon=${sides === undefined ? linkIcon : unlinkIcon} size="14"></sf-icon
            ></sf-icon-button>`
          : nothing}
        ${sides === undefined
          ? nothing
          : html`<span class="sides">${['Top', 'Right', 'Bottom', 'Left'].map((side, k) => numberField(`${name} ${side.toLowerCase()} width`, num(sides[k], width), (n) => update({ sides: sides.map((v, j) => (j === k ? Math.max(0, n) : v)) }), { min: 0, max: 1000, unit: 'px', hidden: true }))}</span>`}
        ${blendMenu(`${name} ${paintMessages.blend.toLowerCase()}`, (item['blend'] as BlendModeName | undefined) ?? 'normal', (m) => update({ blend: m }))}`,
      edit,
    });
  });
  const base = leadColor(model.fills.at(-1)?.paint as JsonValue | undefined) ?? '#16151A';
  return html`${count === 0 ? html`<p class="muted">${paintMessages.noStroke}</p>` : rows}
    ${addPaintMenu(paintMessages.addStroke, count, 'strokes', (paint) => edit({ op: 'add', stack: 'strokes', item: { paint: count > 0 || typeof paint !== 'string' ? paint : '#16151A', width: 1, align: 'inside' } }), base)}`;
}

/** The `+ Add ▾` preset menu for effects (and `Replace all ▸` on a multi-selection). */
export function effectPresetMenu(label: string, full: boolean, tokens: readonly string[], pick: (items: readonly EffectValue[] | string) => void): TemplateResult {
  return addMenu(
    label,
    full,
    'effects',
    html`${EFFECT_PRESETS.map(
      (g) => html`<sf-menu-item value=${`group:${g.label}`}>${g.label}</sf-menu-item>
        <sf-menu slot="submenu" label=${g.label}>${g.presets.map((p) => html`<sf-menu-item value=${p.id}>${p.label}</sf-menu-item>`)}</sf-menu>`,
    )}
    ${tokens.length === 0
      ? nothing
      : html`<sf-menu-item value="group:brand">${paintMessages.fromBrand}</sf-menu-item>
          <sf-menu slot="submenu" label=${paintMessages.fromBrand}>${tokens.map((t) => html`<sf-menu-item value=${t}>${t}</sf-menu-item>`)}</sf-menu>`}`,
    (value) => {
      if (value.startsWith('@')) pick(value);
      const preset = effectPreset(value);
      if (preset !== undefined) pick(preset.items);
    },
  );
}

/** The Effects stack of one element (APPEARANCE §2.6). */
export function effectStack(host: PaintHost, model: AppearanceModel, edit: (e: AppearanceEdit) => void): TemplateResult {
  const count = model.effects.length;
  const rows = [...model.effects.keys()].reverse().map((index) => {
    const raw = model.effects[index] as EffectValue | string;
    const item = asItem(raw);
    const update = (patch: Readonly<Record<string, JsonValue>>): void => edit({ op: 'update', stack: 'effects', index, patch });
    const summary = effectRowSummary(raw);
    const name = typeof raw === 'string' ? raw : summary.split(' · ')[0] ?? paintMessages.effects;
    const kind = typeof raw === 'string' ? undefined : raw.kind;
    const lit = kind !== undefined && kind !== 'layer-blur' && kind !== 'background-blur';
    const color = typeof item['color'] === 'string' ? (item['color'] as string) : '#16151A33';
    const detail =
      kind === undefined
        ? nothing
        : kind === 'layer-blur' || kind === 'background-blur'
          ? numberField(`${name} radius`, num(item['radius'], 4), (n) => update({ radius: Math.max(0, Math.min(250, n)) }), { min: 0, max: 250, unit: 'px' })
          : html`${kind === 'drop-shadow' || kind === 'inner-shadow'
                ? html`${numberField(`${name} ${paintMessages.x}`, num(item['x'], 0), (n) => update({ x: Math.max(-500, Math.min(500, n)) }), { min: -500, max: 500 })}
                  ${numberField(`${name} ${paintMessages.y}`, num(item['y'], 0), (n) => update({ y: Math.max(-500, Math.min(500, n)) }), { min: -500, max: 500 })}`
                : html`<sf-button size="sm" variant="ghost" aria-label=${`${name}: inner`} .pressed=${kind === 'inner-glow'} @click=${() => update({ kind: kind === 'inner-glow' ? 'outer-glow' : 'inner-glow' })}>Inner</sf-button>`}
              ${numberField(`${name} ${paintMessages.blur.toLowerCase()}`, num(item['blur'], 0), (n) => update({ blur: Math.max(0, Math.min(250, n)) }), { min: 0, max: 250 })}
              ${numberField(`${name} ${paintMessages.spread.toLowerCase()}`, num(item['spread'], 0), (n) => update({ spread: Math.max(-100, Math.min(100, n)) }), { min: -100, max: 100 })}
              ${colorSwatch(host, `${name} colour`, host.resolve(color) ?? color, (c) => update({ color: c }))}`;
    return stackRow(host, {
      stack: 'effects',
      index,
      count,
      item: typeof raw === 'string' ? {} : item,
      name,
      swatch: lit ? html`<sf-swatch color=${host.resolve(color) ?? color}></sf-swatch>` : html`<span class="thumb" aria-hidden="true"></span>`,
      summary: { title: summary },
      detail,
      edit,
      opacity: false,
    });
  });
  return html`${model.effectsPreset === undefined ? nothing : html`<p><sf-tag mono>${model.effectsPreset}</sf-tag></p>`}
    ${count === 0 && model.effectsPreset === undefined ? html`<p class="muted">${paintMessages.noEffects}</p>` : rows}
    ${effectPresetMenu(paintMessages.addEffect, count >= MAX_STACK_ITEMS, model.tokens.effects, (items) => {
      if (typeof items === 'string') edit({ op: 'set', path: P.effects, value: items });
      else for (const item of items) edit({ op: 'add', stack: 'effects', item });
    })}`;
}

/** Corners (rects, frames, images; APPEARANCE §4.5): linked radius, per-corner toggle and fields, Smooth. */
export function cornersSection(model: AppearanceModel, edit: (e: AppearanceEdit) => void): TemplateResult {
  const radius = typeof model.radius === 'number' ? model.radius : 0;
  return html`<div class="row">
      ${numberField(paintMessages.radius, radius, (n) => edit({ op: 'set', path: P.radius, value: Math.max(0, n) }), { min: 0, max: 10000, unit: 'px' })}
      <sf-icon-button size="sm" variant="ghost" label=${model.cornersLinked ? paintMessages.perCorner : paintMessages.linkCorners} .pressed=${!model.cornersLinked} @click=${() => edit({ op: 'link-corners', linked: !model.cornersLinked })}
        ><sf-icon .icon=${model.cornersLinked ? linkIcon : unlinkIcon} size="14"></sf-icon
      ></sf-icon-button>
    </div>
    ${model.cornersLinked
      ? nothing
      : html`<div class="grid2">
          ${CORNER_PATHS.map((path, i) => {
            const v = model.corners[i];
            return numberField(paintMessages.corner[i] ?? '', typeof v === 'number' ? v : radius, (n) => edit({ op: 'set', path, value: Math.max(0, n) }), { min: 0, max: 10000, unit: 'px' });
          })}
        </div>`}
    <sf-slider
      label=${paintMessages.smooth}
      min="0"
      max="100"
      step="1"
      unit="%"
      show-value
      .value=${Math.round(model.smoothing * 100)}
      @sf-change=${(e: CustomEvent<{ value: number }>) => edit({ op: 'set', path: P.smoothing, value: Math.max(0, Math.min(1, Number(e.detail.value) / 100)) })}
    ></sf-slider>`;
}

/** Layer opacity and blend (APPEARANCE §2.7), for one element or every selected one. */
export function layerSection(opacity: number | 'mixed', blend: BlendModeName | 'mixed', setOpacity: (o: number) => void, setBlend: (b: BlendModeName) => void): TemplateResult {
  return html`<sf-slider
      label=${paintMessages.opacity}
      min="0"
      max="100"
      step="1"
      unit="%"
      show-value
      .value=${opacity === 'mixed' ? 100 : Math.round(opacity * 100)}
      @sf-change=${(e: CustomEvent<{ value: number }>) => setOpacity(Math.max(0, Math.min(1, Number(e.detail.value) / 100)))}
    ></sf-slider>
    <div class="row"><span class="label">${paintMessages.blend}</span>${blendMenu(`Layer ${paintMessages.blend.toLowerCase()}`, blend, setBlend)}</div>`;
}

/** A multi-selection's Fill or Stroke: one row (the shared top paint, or `Mixed`) that replaces every element's top paint. */
export function sharedPaintRow(host: PaintHost, name: string, mixedLabel: string, paint: PaintSummary | undefined, apply: (paint: string) => void): TemplateResult {
  const mixed = paint?.kind === 'mixed';
  const none = paint === undefined || paint.kind === 'none';
  return html`<div class="stack-row">
    <div class="line">
      ${colorSwatch(host, mixed ? `${name}: ${paintMessages.replaceAll}` : name, paint?.color, apply, { mixed, unresolved: paint?.unresolved === true, ...(paint?.token === undefined ? {} : { token: paint.token.slice(1) }) })}
      <span class="summary static">${mixed ? mixedLabel : none ? (name === paintMessages.fill ? paintMessages.noFill : paintMessages.noStroke) : (paint?.token ?? paint?.color?.toUpperCase() ?? '')}</span>
    </div>
  </div>`;
}
