/**
 * `<if-hud>` — the selection pill (B11b, IF-36.7–36.10; STUDIO-UX-SPEC §4.2): a floating `toolbar` named `Selection
 * actions` with the top six controls of the selection kind (`hudControls(CONTROL_SETS[kind])`), then `⋯` More (a
 * searchable menu of every other action the selection can run, grouped, with shortcuts). It holds no logic: values come
 * from the editor's selection summary and the typography mirror, edits go through `HudPort` (the same capabilities and
 * mirror actions the inspector, the context menu and the keyboard use).
 *
 * Views are a table keyed by control id (`VIEWS`); a view returns `nothing` when its value does not apply to the
 * element in front of it (Radius on an ellipse), so ranks stay fixed per kind (§4.2.2: the first three slots never move).
 * Swatches open the shared colour popover, `Font ▾` the font picker, `Align ▾` the alignment popover; while one of
 * them is open the pill reports `frozen` (`if-hud-freeze`) so the host stops moving it. Arrow keys rove the items.
 */
import { defineIconElement } from '@staticflux/kit/icon';
import { defineIconButton } from '@staticflux/kit/icon-button';
import { chevronDownIcon } from '@staticflux/kit/icons/chevron-down';
import { ellipsisIcon } from '@staticflux/kit/icons/ellipsis';
import { textAlignCenterIcon } from '@staticflux/kit/icons/text-align-center';
import { textAlignEndIcon } from '@staticflux/kit/icons/text-align-end';
import { textAlignStartIcon } from '@staticflux/kit/icons/text-align-start';
import { defineMenu } from '@staticflux/kit/menu';
import { defineNumberField, type NumberChangeDetail } from '@staticflux/kit/number-field';
import { definePopover } from '@staticflux/kit/popover';
import { defineSwatch } from '@staticflux/kit/swatch';
import { defineTag } from '@staticflux/kit/tag';
import { defineButton } from '@staticflux/kit/button';
import { defineColorPopover, type ColorChangeDetail, type DocumentColor, pushRecentColor } from '@staticflux/kit/color-popover';
import { defineFontPicker, type FontEntry } from '@staticflux/kit/font-picker';
import { defineAlignPopover, type AlignDetail } from '@staticflux/kit/align-popover';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import type { PaintSummary, SelectionSummary } from '../app/scene-summary.js';
import { P } from '../elements/components.js';
import { hudControls, MORE_GROUPS, type ControlDecl, type MoreGroup } from '../spec/controls.js';
import { MIXED, type FontChoice, type TypographySummary } from '../text/typography.js';
import { CLEAN_POP_COLOR_PALETTE } from '../theme/palette.js';
import { CONTROL, CONTROL_SETS, MORE_EXCLUDED, MORE_GROUP_OF, SECTIONS } from './studio-controls.js';

export const hudMessages = Object.freeze({
  hud: 'Selection actions',
  more: 'More actions',
  filter: 'Search actions',
  locked: 'Locked',
  mixed: 'Mixed',
  fitLabels: { cover: 'Fill', contain: 'Fit', stretch: 'Stretch', tile: 'Tile' } as Readonly<Record<string, string>>,
  operations: { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' } as Readonly<Record<string, string>>,
  maskModes: { clip: 'Clip', alpha: 'Alpha', luminance: 'Luminance' } as Readonly<Record<string, string>>,
  repeatKinds: { radial: 'Radial', grid: 'Grid', mirror: 'Mirror' } as Readonly<Record<string, string>>,
  textAlign: { start: 'Align text left', center: 'Centre text', end: 'Align text right', justify: 'Justify text' } as Readonly<Record<string, string>>,
  freeTransform: 'Free transform',
});

/** The capability titles and keys the More menu shows (from the registry; data). */
export interface HudAction {
  readonly id: string;
  readonly title: string;
  readonly shortcut?: string;
}

/** What the pill runs: one port for everything (the inspector and menus use the same). */
export interface HudPort {
  /** Run a capability on `nodes` (default: the selection) with extra input. */
  invoke(capability: string, extra?: Readonly<Record<string, unknown>>, nodes?: readonly string[]): void;
  /** The top fill / stroke paint of every selected element (one undo step `label`). */
  setPaint(stack: 'fills' | 'strokes', paint: string, label: string): void;
  /** One property on every selected element. */
  setProp(path: string, value: unknown, label: string): void;
  /** B2's typography on the selection or the edited range. */
  setFont(font: FontChoice['value']): void;
  setSize(size: number): void;
  setTextColor(color: string): void;
  toggleText(key: 'bold' | 'italic' | 'underline' | 'strike'): void;
  setTextAlign(align: 'start' | 'center' | 'end' | 'justify'): void;
  /** A repeat parameter (`count`, …). */
  setRepeat(patch: Readonly<Record<string, number>>): void;
  /** A HUD command the editor runs (Free transform). */
  command(id: string): void;
}

const spec = component({ tag: 'if-hud', placeholder: () => nothing, description: 'Instaflow selection pill: ranked controls of the selection kind, More menu (B11b).' });

const RECENT_KEY = 'instaflow/ui/recent-colours';
const readRecent = (): string[] => {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    const list = raw === null || raw === undefined ? [] : (JSON.parse(raw) as unknown);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const writeRecent = (list: readonly string[]): void => {
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Private mode or blocked storage: recents stay for the session.
  }
};

/** A colour popover commit as a paint value (`#rrggbbaa` with alpha, or `@token`). */
export function paintFromColor(detail: ColorChangeDetail): string {
  if (detail.kind === 'token') return `@${detail.token}`;
  const alpha = detail.kind === 'color' ? detail.opacity : 1;
  if (alpha >= 1) return detail.hex.toUpperCase();
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${detail.hex.slice(0, 7).toUpperCase()}${a.toUpperCase()}`;
}

/** The capabilities a pill already shows for this kind (the More menu skips them). */
export function pillCapabilities(controls: readonly ControlDecl[]): Set<string> {
  return new Set(controls.flatMap((c) => (c.capability === undefined ? [] : [c.capability.id as string])));
}

/** The More menu: applicable actions not in the pill, grouped (STUDIO §4.2.3); unknown ids (not in `actions`) are dropped. */
export function moreMenuGroups(summary: SelectionSummary, pill: ReadonlySet<string>, actions: ReadonlyMap<string, HudAction>): readonly (readonly [MoreGroup, readonly HudAction[]])[] {
  const groups = new Map<MoreGroup, HudAction[]>();
  for (const id of summary.actions) {
    if (pill.has(id) || MORE_EXCLUDED.has(id)) continue;
    const action = actions.get(id);
    if (action === undefined) continue;
    const group = MORE_GROUP_OF[id] ?? 'Arrange';
    const list = groups.get(group) ?? [];
    if (!list.some((a) => a.id === id)) list.push(action);
    groups.set(group, list);
  }
  return MORE_GROUPS.flatMap((g) => (groups.has(g) ? [[g, groups.get(g) as HudAction[]] as const] : []));
}

const swatchProps = (paint: PaintSummary | undefined): { color: string; unresolved: boolean; mixed: boolean } => ({
  color: paint?.color ?? '#00000000',
  unresolved: paint?.unresolved === true,
  mixed: paint?.kind === 'mixed',
});

export class IfHudElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    summary: { attribute: false },
    typography: { attribute: false },
    fonts: { attribute: false },
    actions: { attribute: false },
    documentColors: { attribute: false },
    port: { attribute: false },
    pro: { type: Boolean },
    recent: { state: true },
  };
  static override styles = css`
    :host {
      display: inline-flex;
      position: absolute;
      z-index: 2;
    }
    [role='toolbar'] {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      background: ${t.color.surface2.css};
      border-radius: ${t.radius.full.css};
      box-shadow:
        0 1px 2px rgba(22, 21, 26, 0.08),
        0 10px 28px rgba(22, 21, 26, 0.18);
      white-space: nowrap;
    }
    .divider {
      inline-size: 1px;
      block-size: 16px;
      background: ${t.color.border.css};
      margin-inline: 2px;
    }
    .value {
      font-family: ${t.font.familyMono.css};
    }
    sf-number-field {
      inline-size: 72px;
    }
    .font {
      max-inline-size: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    sf-tag {
      margin-inline: 4px;
    }
  `;

  declare summary: SelectionSummary | undefined;
  declare typography: TypographySummary | undefined;
  declare fonts: readonly FontChoice[];
  declare actions: ReadonlyMap<string, HudAction>;
  declare documentColors: readonly DocumentColor[];
  declare port: HudPort | undefined;
  declare pro: boolean;
  declare recent: readonly string[];
  private open = 0;

  constructor() {
    super();
    this.summary = undefined;
    this.typography = undefined;
    this.fonts = [];
    this.actions = new Map();
    this.documentColors = [];
    this.port = undefined;
    this.pro = false;
    this.recent = readRecent();
  }

  /** Focus the first item (`Alt+Enter`). */
  focusFirst(): void {
    this.items()[0]?.focus();
  }

  private items(): HTMLElement[] {
    return [...this.renderRoot.querySelectorAll<HTMLElement>('[data-hud-item]')];
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const items = this.items();
    const path = e.composedPath();
    const at = items.findIndex((item) => path.includes(item));
    if (at < 0) return;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    e.preventDefault();
    items[next]?.focus();
  }

  private toggled(e: CustomEvent<{ open: boolean }>): void {
    this.open = Math.max(0, this.open + (e.detail.open ? 1 : -1));
    this.dispatchEvent(new CustomEvent('if-hud-freeze', { detail: { frozen: this.open > 0 }, bubbles: true, composed: true }));
  }

  private commitColor(detail: ColorChangeDetail, apply: (paint: string) => void): void {
    if (detail.kind !== 'token') {
      this.recent = pushRecentColor(this.recent, detail.hex);
      writeRecent(this.recent);
    }
    apply(paintFromColor(detail));
  }

  private swatch(label: string, paint: PaintSummary | undefined, apply: (paint: string) => void): TemplateResult {
    const s = swatchProps(paint);
    return html`<sf-popover label=${`${label} colour`} outside="pass" @sf-toggle=${(e: CustomEvent<{ open: boolean }>) => this.toggled(e)}>
      <sf-icon-button slot="trigger" data-hud-item size="sm" variant="ghost" label=${label} tooltip-side="block-start"
        ><sf-swatch color=${s.color} ?unresolved=${s.unresolved || s.mixed}></sf-swatch
      ></sf-icon-button>
      <sf-color-popover
        label=${`${label} colour`}
        value=${s.mixed ? '' : (paint?.color ?? '').slice(0, 7)}
        ?mixed=${s.mixed}
        ?custom-open=${this.pro}
        ?captions=${this.pro}
        .documentColors=${this.documentColors}
        .palette=${CLEAN_POP_COLOR_PALETTE}
        .recent=${this.recent}
        @sf-change=${(e: CustomEvent<ColorChangeDetail>) => this.commitColor(e.detail, apply)}
      ></sf-color-popover>
    </sf-popover>`;
  }

  private menu(label: string, value: string, items: readonly (readonly [string, string])[], pick: (value: string) => void): TemplateResult {
    return html`<sf-menu label=${label} @sf-select=${(e: CustomEvent<{ value: string }>) => pick(e.detail.value)} @sf-toggle=${(e: CustomEvent<{ open: boolean }>) => this.toggled(e)}>
      <sf-button slot="trigger" data-hud-item size="sm" variant="ghost" aria-label=${`${label}: ${value}`}>${value} <sf-icon .icon=${chevronDownIcon} size="16"></sf-icon></sf-button>
      ${items.map(([v, text]) => html`<sf-menu-item value=${v} type="radio" ?checked=${text === value}>${text}</sf-menu-item>`)}
    </sf-menu>`;
  }

  private number(label: string, value: number | 'mixed' | undefined, commit: (n: number) => void, options: { min?: number; max?: number; unit?: string } = {}): TemplateResult {
    return html`<sf-number-field
      data-hud-item
      label=${label}
      label-hidden
      .value=${value === 'mixed' ? undefined : value}
      ?mixed=${value === 'mixed'}
      min=${options.min ?? 0}
      max=${options.max ?? 100000}
      unit=${this.pro ? (options.unit ?? '') : ''}
      @sf-change=${(e: CustomEvent<NumberChangeDetail>) => {
        if (e.detail.value !== undefined) commit(e.detail.value);
      }}
    ></sf-number-field>`;
  }

  private action(control: ControlDecl, nodes?: readonly string[]): TemplateResult | typeof nothing {
    const port = this.port;
    const capability = control.capability?.id as string | undefined;
    if (port === undefined || capability === undefined) return nothing;
    const extra = control.id === CONTROL.unlock ? { locked: false } : undefined;
    return html`<sf-icon-button
      data-hud-item
      size="sm"
      variant="ghost"
      label=${control.label}
      shortcut=${control.shortcut ?? nothing}
      description=${this.pro ? (control.description ?? nothing) : nothing}
      tooltip-side="block-start"
      @click=${() => port.invoke(capability, extra, nodes)}
      >${control.icon === undefined ? control.label : html`<sf-icon .icon=${control.icon} size="16"></sf-icon>`}</sf-icon-button
    >`;
  }

  /** One view per value control (rule 4: a table, never a branch on the kind). */
  private readonly VIEWS: Readonly<Record<string, (control: ControlDecl, s: SelectionSummary, port: HudPort) => TemplateResult | typeof nothing>> = {
    [CONTROL.fill]: (c, s, port) => (s.fill === undefined ? nothing : this.swatch(c.label, s.fill, (paint) => port.setPaint('fills', paint, 'Fill'))),
    [CONTROL.stroke]: (c, s, port) => (s.stroke === undefined ? nothing : this.swatch(c.label, s.stroke, (paint) => port.setPaint('strokes', paint, 'Stroke'))),
    [CONTROL.radius]: (c, s, port) => (s.common === 'rectangle' || s.common === 'frame' ? this.number(c.label, s.radius, (n) => port.setProp(P.radius, n, 'Radius'), { unit: 'px' }) : nothing),
    [CONTROL.points]: (c, s, port) => (s.points === undefined ? nothing : this.number(c.label, s.points, (n) => port.setProp(P.sides, Math.round(n), 'Points'), { min: 3, max: 1000 })),
    [CONTROL.strokeWidth]: (c, s, port) => (s.common === 'line' ? this.number(c.label, s.stroke?.width, (n) => port.setProp(P.strokes, [{ paint: s.stroke?.color ?? '#16151A', width: Math.max(0.5, n), align: 'center' }], 'Stroke width'), { unit: 'px' }) : nothing),
    [CONTROL.font]: (c, _s, port) => this.fontPicker(c, port),
    [CONTROL.size]: (c, _s, port) => {
      const size = this.typography?.size;
      return this.number(c.label, size === MIXED ? 'mixed' : size, (n) => port.setSize(n), { min: 1, max: 999, unit: 'px' });
    },
    [CONTROL.textColor]: (c, _s, port) => {
      const color = this.typography?.color;
      const paint: PaintSummary = color === MIXED ? { kind: 'mixed' } : typeof color === 'string' ? { kind: 'solid', color } : { kind: 'solid', color: '#16151A' };
      return this.swatch(c.label, paint, (value) => port.setTextColor(value));
    },
    [CONTROL.bold]: (c, _s, port) =>
      html`<sf-icon-button data-hud-item size="sm" variant="ghost" label=${c.label} shortcut=${c.shortcut ?? nothing} tooltip-side="block-start" .pressed=${this.typography?.bold === true} @click=${() => port.toggleText('bold')}
        ><sf-icon .icon=${c.icon} size="16"></sf-icon
      ></sf-icon-button>`,
    [CONTROL.align]: (c, s, port) => (s.kind === 'text' ? this.textAlign(c, port) : this.alignPopover(c, s, port)),
    [CONTROL.distribute]: (c, s, port) => {
      const items = (
        [
          ['instaflow/distribute-h-spacing', 'Horizontal spacing'],
          ['instaflow/distribute-v-spacing', 'Vertical spacing'],
          ['instaflow/tidy-up', 'Tidy up'],
        ] as const
      ).filter(([id]) => s.actions.includes(id));
      return items.length === 0 ? nothing : this.menu(c.label, c.label, items, (id) => port.invoke(id));
    },
    [CONTROL.fit]: (c, s, port) => this.menu(c.label, hudMessages.fitLabels[s.fit ?? 'cover'] ?? 'Fill', Object.entries(hudMessages.fitLabels), (fit) => port.setProp(P.fit, fit, 'Fit')),
    [CONTROL.clip]: (c, s, port) =>
      html`<sf-icon-button data-hud-item size="sm" variant="ghost" label=${c.label} tooltip-side="block-start" .pressed=${s.clip === true} @click=${() => port.setProp(P.clip, !(s.clip === true), 'Clip content')}
        ><sf-icon .icon=${c.icon} size="16"></sf-icon
      ></sf-icon-button>`,
    [CONTROL.combine]: (c, s, port) => {
      const items = Object.entries(hudMessages.operations).filter(([op]) => s.actions.includes(`instaflow/boolean-${op}`));
      return items.length === 0 ? nothing : this.menu(c.label, c.label, items, (op) => port.invoke(`instaflow/boolean-${op}`));
    },
    [CONTROL.useAsMask]: (c, s, port) => (s.actions.includes('instaflow/mask-clip') ? this.menu(c.label, c.label, Object.entries(hudMessages.maskModes), (mode) => port.invoke(`instaflow/mask-${mode}`)) : nothing),
    [CONTROL.operation]: (c, s, port) => this.menu(c.label, hudMessages.operations[s.booleanOp ?? 'union'] ?? 'Union', Object.entries(hudMessages.operations), (op) => port.setProp(P.boolean, op, hudMessages.operations[op] ?? 'Operation')),
    [CONTROL.maskMode]: (c, s, port) =>
      s.mask === undefined ? nothing : this.menu(c.label, hudMessages.maskModes[s.mask.mode] ?? 'Clip', Object.entries(hudMessages.maskModes), (mode) => port.invoke(`instaflow/mask-${mode}`, undefined, [s.mask?.node ?? ''])),
    [CONTROL.maskInvert]: (c, s, port) =>
      s.mask === undefined
        ? nothing
        : html`<sf-button data-hud-item size="sm" variant="ghost" .pressed=${s.mask.invert} @click=${() => port.invoke('instaflow/mask-invert', undefined, [s.mask?.node ?? ''])}>${c.label}</sf-button>`,
    [CONTROL.chip]: (_c, s) =>
      html`<sf-tag mono>${s.kind === 'locked' ? hudMessages.locked : s.repeat === undefined ? '' : `${hudMessages.repeatKinds[s.repeat.kind] ?? s.repeat.kind} · ${s.repeat.count}`}</sf-tag>`,
    [CONTROL.repeatCount]: (c, s, port) => (s.repeat?.kind === 'radial' ? this.number(c.label, s.repeat.count, (n) => port.setRepeat({ count: Math.round(n) }), { min: 1, max: 1000 }) : nothing),
  };

  private fontPicker(c: ControlDecl, port: HudPort): TemplateResult {
    const current = this.typography?.font;
    const family = current === MIXED ? hudMessages.mixed : current !== undefined && 'family' in current ? (current.family ?? 'Font') : 'Font';
    const fonts: FontEntry[] = this.fonts.map((f) => ({ family: f.label, cached: true }));
    return html`<sf-popover label="Font" outside="pass" @sf-toggle=${(e: CustomEvent<{ open: boolean }>) => this.toggled(e)}>
      <sf-button slot="trigger" data-hud-item size="sm" variant="ghost" aria-label=${`${c.label}: ${family}`}
        ><span class="font" style=${`font-family:"${family}"`}>${family}</span> <sf-icon .icon=${chevronDownIcon} size="16"></sf-icon
      ></sf-button>
      <sf-font-picker
        value=${family}
        .fonts=${fonts}
        @sf-change=${(e: CustomEvent<{ family: string }>) => {
          const choice = this.fonts.find((f) => f.label === e.detail.family);
          if (choice !== undefined) port.setFont(choice.value);
        }}
      ></sf-font-picker>
    </sf-popover>`;
  }

  private textAlign(c: ControlDecl, port: HudPort): TemplateResult {
    const icons = { start: textAlignStartIcon, center: textAlignCenterIcon, end: textAlignEndIcon, justify: textAlignStartIcon };
    const align = this.typography?.align;
    const current = align === MIXED || align === undefined ? 'start' : align;
    return html`<sf-menu label="Text alignment" @sf-select=${(e: CustomEvent<{ value: 'start' | 'center' | 'end' | 'justify' }>) => port.setTextAlign(e.detail.value)} @sf-toggle=${(e: CustomEvent<{ open: boolean }>) => this.toggled(e)}>
      <sf-button slot="trigger" data-hud-item size="sm" variant="ghost" aria-label=${`${c.label}: ${hudMessages.textAlign[current]}`}
        ><sf-icon .icon=${icons[current]} size="16"></sf-icon> <sf-icon .icon=${chevronDownIcon} size="16"></sf-icon
      ></sf-button>
      ${(['start', 'center', 'end', 'justify'] as const).map(
        (a) => html`<sf-menu-item value=${a} type="radio" ?checked=${a === current} .icon=${icons[a]} shortcut=${{ start: 'Mod+Shift+L', center: 'Mod+Shift+E', end: 'Mod+Shift+R', justify: 'Mod+Shift+J' }[a]}>${hudMessages.textAlign[a]}</sf-menu-item>`,
      )}
    </sf-menu>`;
  }

  private alignPopover(c: ControlDecl, s: SelectionSummary, port: HudPort): TemplateResult {
    const many = s.nodes.length > 1;
    const EDGES: Readonly<Record<string, string>> = { left: 'left', center: 'center-x', right: 'right', top: 'top', middle: 'center-y', bottom: 'bottom' };
    const run = (detail: AlignDetail): void => {
      const target = !many || detail.to === 'page' ? { target: 'page' } : undefined;
      if (detail.action === 'distribute-horizontal') port.invoke('instaflow/distribute-h-spacing');
      else if (detail.action === 'distribute-vertical') port.invoke('instaflow/distribute-v-spacing');
      else if (detail.action === 'tidy-up') port.invoke('instaflow/tidy-up');
      else port.invoke(`instaflow/align-${EDGES[detail.action] ?? detail.action}`, target);
    };
    return html`<sf-popover label="Align" outside="pass" @sf-toggle=${(e: CustomEvent<{ open: boolean }>) => this.toggled(e)}>
      <sf-button slot="trigger" data-hud-item size="sm" variant="ghost" aria-label=${c.label}><sf-icon .icon=${c.icon} size="16"></sf-icon> <sf-icon .icon=${chevronDownIcon} size="16"></sf-icon></sf-button>
      <sf-align-popover count=${s.nodes.length} to=${many ? 'selection' : 'page'} @sf-align=${(e: CustomEvent<AlignDetail>) => run(e.detail)}></sf-align-popover>
    </sf-popover>`;
  }

  private more(s: SelectionSummary, pill: ReadonlySet<string>, port: HudPort): TemplateResult | typeof nothing {
    const groups = moreMenuGroups(s, pill, this.actions);
    const canTransform = s.kind !== 'locked' && s.nodes.length > 0;
    if (groups.length === 0 && !canTransform) return nothing;
    const pick = (value: string): void => (value === 'instaflow/free-transform-hud' ? port.command(value) : port.invoke(value));
    return html`<span class="divider" aria-hidden="true"></span>
      <sf-menu label=${hudMessages.more} filterable filter-label=${hudMessages.filter} @sf-select=${(e: CustomEvent<{ value: string }>) => pick(e.detail.value)} @sf-toggle=${(e: CustomEvent<{ open: boolean }>) => this.toggled(e)}>
        <sf-icon-button slot="trigger" data-hud-item size="sm" variant="ghost" label=${hudMessages.more} tooltip-side="block-start"><sf-icon .icon=${ellipsisIcon} size="16"></sf-icon></sf-icon-button>
        ${groups.map(
          ([group, actions]) =>
            html`<sf-menu-group label=${group}>
              ${actions.map((a) => html`<sf-menu-item value=${a.id} shortcut=${a.shortcut ?? nothing}>${a.title}</sf-menu-item>`)}
              ${group === 'Transform' && canTransform ? html`<sf-menu-item value="instaflow/free-transform-hud" shortcut="Mod+T">${hudMessages.freeTransform}</sf-menu-item>` : nothing}
            </sf-menu-group>`,
        )}
      </sf-menu>`;
  }

  override render(): TemplateResult | typeof nothing {
    const s = this.summary;
    const port = this.port;
    if (s === undefined || port === undefined || s.kind === 'none') return nothing;
    const controls = hudControls(CONTROL_SETS[s.kind]);
    const pill = pillCapabilities(controls);
    return html`<div role="toolbar" aria-label=${hudMessages.hud} data-sf-overlay="hud" @keydown=${(e: KeyboardEvent) => this.onKey(e)}>
      ${controls.map((control) => {
        const view = this.VIEWS[control.id];
        if (view !== undefined) return view(control, s, port);
        return this.action(control, control.section === SECTIONS.mask && s.mask !== undefined ? [s.mask.node] : undefined);
      })}
      ${this.more(s, pill, port)}
    </div>`;
  }
}

/** Define `<if-hud>` and the kit pieces it renders. */
export function defineHud(registry: CustomElementRegistry = customElements): void {
  defineIconElement(registry);
  defineIconButton(registry);
  defineButton(registry);
  defineMenu(registry);
  defineNumberField(registry);
  definePopover(registry);
  defineSwatch(registry);
  defineTag(registry);
  defineColorPopover(registry);
  defineFontPicker(registry);
  defineAlignPopover(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfHudElement, registry);
}
