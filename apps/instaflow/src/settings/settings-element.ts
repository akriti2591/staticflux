/**
 * `<if-settings>` — Settings (B11c; STUDIO-UX-SPEC §2.4, DENSITY-DISCLOSURE §7–§8.3): a page in Home's shell
 * (`/settings/:section?`) and the body of a dialog over Studio (`/d/settings?section=`), the same element in both. A
 * list of sections on the left, the section on the right; every change applies at once and says `Saved on this device`
 * (no Save button). M1 sections:
 *
 * - **General**: Density (Focus · Standard · Pro with their one-liners and a preview strip); `More ▾` Units (New
 *   design's default), Reduced motion (follow the system, reduce, full), `Show first-use hints` and `Reset hints`.
 * - **Keyboard shortcuts**: the kit's `<sf-shortcut-sheet>` over the groups the host gives (Studio's registry
 *   snapshot; Home's own card on Home), search and the `Mac · Windows` switch.
 * - **Storage**: space used (a bar), whether the browser keeps the workspace (`Keep my designs on this device` asks on
 *   the click), the trash.
 * - **About**: version, `Copy diagnostics`; `More ▾` licences (fonts, icons, the fonts you added).
 *
 * The element owns no storage: it reads and writes `DeviceSettings` and asks the host through events (`if-section`,
 * `if-reset-hints`, `if-open-trash`). Pro opens every `More ▾`.
 */
import { defineButton } from '@staticflux/kit/button';
import { defineDisclosure } from '@staticflux/kit/disclosure';
import { defineSegmented } from '@staticflux/kit/segmented';
import { defineShortcutSheet, type ShortcutSheetGroup, type SfShortcutSheetElement } from '@staticflux/kit/shortcut-sheet';
import { component, defineComponent, SfElement } from '@staticflux/ui';
import { themeTokens as t } from '@staticflux/ui/theme';
import { css, html, nothing, type TemplateResult } from 'lit';
import { DENSITY_LINES, DEVICE_DENSITIES, type DeviceDensity, type DeviceSettings, MOTION_SETTINGS, type MotionSetting, UNIT_SETTINGS, type UnitSetting } from './device-settings.js';

export const SETTINGS_TAG = 'if-settings';
export const SETTINGS_SECTIONS = ['general', 'shortcuts', 'storage', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** What Instaflow is (About). */
export const INSTAFLOW_VERSION = 'M1 preview';

/** Licences of what Instaflow ships (About › More), data. */
export const LICENCES: readonly { readonly name: string; readonly what: string; readonly licence: string }[] = Object.freeze([
  { name: 'Noto Sans', what: 'Default document fonts (Latin, Arabic, Devanagari, Thai)', licence: 'SIL Open Font License 1.1' },
  { name: 'Bricolage Grotesque', what: 'Headings', licence: 'SIL Open Font License 1.1' },
  { name: 'Geist and Geist Mono', what: 'Interface text and values', licence: 'SIL Open Font License 1.1' },
  { name: 'Lucide', what: 'Icons', licence: 'ISC License' },
]);

export const settingsMessages = Object.freeze({
  settings: 'Settings',
  sections: 'Settings sections',
  titles: { general: 'General', shortcuts: 'Keyboard shortcuts', storage: 'Storage', about: 'About' } as Readonly<Record<SettingsSection, string>>,
  saved: 'Saved on this device',
  density: 'Density',
  more: 'More',
  units: 'Units',
  unitsHint: 'New designs start in these units.',
  motion: 'Reduced motion',
  motions: { system: 'Follow the system', reduce: 'Reduce', full: 'Full' } as Readonly<Record<MotionSetting, string>>,
  hints: 'Show first-use hints',
  hintsHint: 'One sentence the first time you use a tool. Never a tour.',
  resetHints: 'Reset hints',
  hintsReset: 'Hints and the welcome card will show again.',
  used: '{used} used on this device',
  usedOf: '{used} of {quota} available on this device',
  usage: 'Space used',
  persisted: 'This browser keeps your workspace, also under storage pressure.',
  notPersisted: 'This browser may clear your workspace under storage pressure.',
  keep: 'Keep my designs on this device',
  refused: 'The browser said no. Pin this site, or install Instaflow as an app, to keep your workspace.',
  unknown: 'This browser does not say how much space is used.',
  trash: 'Items in the trash are kept for 30 days.',
  openTrash: 'Open Trash',
  version: 'Version',
  copyDiagnostics: 'Copy diagnostics',
  copied: 'Diagnostics copied',
  copyBlocked: 'The browser blocked the clipboard.',
  licences: 'Licences',
  yourFonts: 'Fonts you added',
  yours: 'Yours',
  noShortcuts: 'No shortcut matches.',
});
const m = settingsMessages;

/** `1234567` → `1.2 MB` (decimal units). */
const bytes = (n: number): string => {
  for (const [unit, size] of [
    ['GB', 1e9],
    ['MB', 1e6],
    ['KB', 1e3],
  ] as const)
    if (n >= size) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: unit === 'KB' ? 0 : 1 }).format(n / size)} ${unit}`;
  return `${n} B`;
};
const fill = (s: string, args: Readonly<Record<string, string>>): string => s.replace(/\{(\w+)\}/g, (_, k: string) => args[k] ?? '');

/** Storage facts and the persistence request (structurally `navigator.storage`). */
export interface SettingsStorage {
  estimate?(): Promise<{ readonly usage?: number; readonly quota?: number }>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

const spec = component({
  tag: SETTINGS_TAG,
  placeholder: () => nothing,
  description: 'Settings: General (density, units, motion, hints), Keyboard shortcuts, Storage, About; a page on Home, a dialog over Studio.',
});

/** A 160 × 100 line drawing of Studio per density (the preview strip; decorative). */
function preview(d: DeviceDensity): TemplateResult {
  const DRAW: Readonly<Record<DeviceDensity, TemplateResult>> = {
    focus: html`<rect x="4" y="4" width="152" height="10" rx="3"></rect><rect x="4" y="18" width="8" height="78" rx="2"></rect
      ><rect x="148" y="18" width="8" height="78" rx="2"></rect><rect x="44" y="30" width="72" height="56" rx="3" class="page"></rect>`,
    standard: html`<rect x="4" y="4" width="152" height="10" rx="3"></rect><rect x="4" y="18" width="30" height="78" rx="2"></rect
      ><rect x="126" y="18" width="30" height="78" rx="2"></rect><rect x="54" y="32" width="52" height="52" rx="3" class="page"></rect>`,
    pro: html`<rect x="4" y="4" width="152" height="8" rx="2"></rect><rect x="4" y="16" width="30" height="38" rx="2"></rect><rect x="4" y="58" width="30" height="38" rx="2"></rect
      ><rect x="126" y="16" width="30" height="80" rx="2"></rect><rect x="38" y="16" width="84" height="4" rx="1"></rect><rect x="38" y="16" width="4" height="80" rx="1"></rect
      ><rect x="58" y="32" width="44" height="44" rx="2" class="page"></rect>`,
  };
  return html`<svg viewBox="0 0 160 100" width="160" height="100" aria-hidden="true" focusable="false">${DRAW[d]}</svg>`;
}

export class IfSettingsElement extends SfElement<typeof spec> {
  static override readonly spec = spec;
  static override properties = {
    section: { reflect: true },
    settings: { attribute: false },
    storage: { attribute: false },
    shortcuts: { attribute: false },
    diagnostics: { attribute: false },
    userFonts: { attribute: false },
    trashCount: { attribute: false },
    facts: { state: true },
    note: { state: true },
  };
  static override styles = css`
    :host {
      display: grid;
      grid-template-columns: 184px minmax(0, 1fr);
      gap: ${t.space.xl.css};
      color: ${t.color.text.css};
      font-family: ${t.font.family.css};
      font-size: ${t.type.sizeMd.css};
    }
    nav ul {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    nav a {
      display: block;
      padding: 8px 12px;
      border-radius: ${t.radius.control.css};
      color: ${t.color.textMuted.css};
      font-weight: ${t.font.weightSemibold.css};
      text-decoration: none;
    }
    nav a:hover {
      color: ${t.color.text.css};
      background: ${t.color.neutral3.css};
    }
    nav a[aria-current='page'] {
      color: ${t.color.accentText.css};
      background: ${t.color.accentSubtle.css};
    }
    a:focus-visible,
    input:focus-visible {
      outline: 2px solid ${t.color.focusRing.css};
      outline-offset: 2px;
    }
    section {
      display: flex;
      flex-direction: column;
      gap: ${t.space.lg.css};
      min-inline-size: 0;
    }
    h2 {
      margin: 0;
      font-family: ${t.font.familyDisplay.css};
      font-weight: ${t.font.weightDisplay.css};
      font-size: 22px;
    }
    h3 {
      margin: 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: ${t.color.textMuted.css};
    }
    p {
      margin: 0;
    }
    .muted {
      color: ${t.color.textMuted.css};
      font-size: ${t.type.sizeSm.css};
    }
    fieldset {
      margin: 0;
      padding: 0;
      border: 0;
      display: flex;
      flex-direction: column;
      gap: ${t.space.sm.css};
    }
    legend {
      padding: 0;
      margin-block-end: ${t.space.sm.css};
      font-weight: ${t.font.weightSemibold.css};
    }
    .densities {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: ${t.space.md.css};
    }
    .density {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: ${t.space.md.css};
      border: 1px solid ${t.color.border.css};
      border-radius: ${t.radius.lg.css};
      background: ${t.color.surface2.css};
      cursor: pointer;
    }
    .density:has(input:checked) {
      border-color: ${t.color.accent.css};
      background: ${t.color.accentSubtle.css};
    }
    .density svg {
      inline-size: 100%;
      block-size: auto;
      fill: ${t.color.neutral4.css};
    }
    .density svg .page {
      fill: ${t.color.surface1.css};
      stroke: ${t.color.borderStrong.css};
    }
    .density .name {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: ${t.font.weightSemibold.css};
    }
    .row {
      display: flex;
      align-items: center;
      gap: ${t.space.md.css};
      flex-wrap: wrap;
    }
    .stack {
      display: flex;
      flex-direction: column;
      gap: ${t.space.md.css};
    }
    .bar {
      block-size: 8px;
      border-radius: 4px;
      background: ${t.color.neutral4.css};
      overflow: hidden;
    }
    .bar > span {
      display: block;
      block-size: 100%;
      background: ${t.color.accent.css};
    }
    dl {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 6px ${t.space.lg.css};
      margin: 0;
    }
    dt {
      color: ${t.color.textMuted.css};
    }
    dd {
      margin: 0;
    }
    .mono {
      font-family: ${t.font.familyMono.css};
    }
    .saved {
      color: ${t.color.textMuted.css};
      font-size: ${t.type.sizeSm.css};
    }
    @media (max-width: 720px) {
      :host {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    @media (forced-colors: active) {
      .density:has(input:checked),
      nav a[aria-current='page'] {
        outline: 2px solid Highlight;
      }
    }
  `;

  declare section: SettingsSection;
  declare settings: DeviceSettings | undefined;
  declare storage: SettingsStorage | undefined;
  declare shortcuts: readonly ShortcutSheetGroup[];
  /** The diagnostics text `Copy diagnostics` writes. */
  declare diagnostics: () => string;
  /** Fonts this workspace imported (About › Licences: yours). */
  declare userFonts: readonly string[];
  declare trashCount: number | undefined;
  declare facts: { readonly usage?: number; readonly quota?: number; readonly persisted?: boolean; readonly refused?: boolean } | undefined;
  declare note: string;

  constructor() {
    super();
    this.section = 'general';
    this.settings = undefined;
    this.storage = undefined;
    this.shortcuts = [];
    this.diagnostics = () => '';
    this.userFonts = [];
    this.trashCount = undefined;
    this.facts = undefined;
    this.note = '';
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.readFacts();
  }

  private async readFacts(): Promise<void> {
    const port = this.storage;
    const estimate = await port?.estimate?.().catch(() => undefined);
    const persisted = await port?.persisted?.().catch(() => undefined);
    this.facts = { ...this.facts, ...(estimate?.usage === undefined ? {} : { usage: estimate.usage }), ...(estimate?.quota === undefined ? {} : { quota: estimate.quota }), ...(persisted === undefined ? {} : { persisted }) };
  }

  private get pro(): boolean {
    return this.settings?.current.density === 'pro';
  }

  private change(patch: Parameters<DeviceSettings['set']>[0]): void {
    this.settings?.set(patch);
    this.note = m.saved;
    this.requestUpdate();
  }

  /** Focus the section's first field (the shortcut search on Shortcuts). */
  async focusSection(): Promise<void> {
    await this.updateComplete;
    if (this.section === 'shortcuts') await this.renderRoot.querySelector<SfShortcutSheetElement>('sf-shortcut-sheet')?.focusSearch();
  }

  private go(e: MouseEvent, section: SettingsSection): void {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    this.section = section;
    this.note = '';
    this.dispatchEvent(new CustomEvent<{ section: SettingsSection }>('if-section', { detail: { section }, bubbles: true, composed: true }));
    void this.focusSection();
  }

  override render(): TemplateResult {
    const SECTIONS: Readonly<Record<SettingsSection, () => TemplateResult>> = {
      general: () => this.renderGeneral(),
      shortcuts: () => this.renderShortcuts(),
      storage: () => this.renderStorage(),
      about: () => this.renderAbout(),
    };
    return html`<nav aria-label=${m.sections}>
        <ul role="list">
          ${SETTINGS_SECTIONS.map(
            (s) => html`<li><a href=${`?section=${s}`} data-section=${s} aria-current=${this.section === s ? 'page' : nothing} @click=${(e: MouseEvent) => this.go(e, s)}>${m.titles[s]}</a></li>`,
          )}
        </ul>
      </nav>
      <section aria-labelledby="settings-heading">
        <h2 id="settings-heading">${m.titles[this.section]}</h2>
        ${SECTIONS[this.section]()}
        <p class="saved" role="status">${this.note}</p>
      </section>`;
  }

  private renderGeneral(): TemplateResult {
    const s = this.settings?.current;
    if (s === undefined) return html``;
    return html`<fieldset>
        <legend>${m.density}</legend>
        <div class="densities">
          ${DEVICE_DENSITIES.map(
            (d) => html`<label class="density" data-density=${d}>
              ${preview(d)}
              <span class="name"><input type="radio" name="density" value=${d} .checked=${s.density === d} @change=${() => this.change({ density: d })} />${DENSITY_LINES[d].name}</span>
              <span class="muted">${DENSITY_LINES[d].line}</span>
            </label>`,
          )}
        </div>
      </fieldset>
      <sf-disclosure variant="more" heading=${m.more} ?open=${this.pro} ?pinned=${this.pro} key="instaflow/settings/general">
        <div class="stack">
          <div class="stack">
            <sf-segmented
              class="units"
              label=${m.units}
              .options=${UNIT_SETTINGS.map((u) => ({ value: u, label: u }))}
              .value=${s.units}
              @sf-change=${(e: CustomEvent<{ value: UnitSetting }>) => this.change({ units: e.detail.value })}
            ></sf-segmented>
            <p class="muted">${m.unitsHint}</p>
          </div>
          <sf-segmented
            class="motion"
            label=${m.motion}
            .options=${MOTION_SETTINGS.map((v) => ({ value: v, label: m.motions[v] }))}
            .value=${s.motion}
            @sf-change=${(e: CustomEvent<{ value: MotionSetting }>) => this.change({ motion: e.detail.value })}
          ></sf-segmented>
          <div class="stack">
            <label class="row"><input class="hints" type="checkbox" .checked=${s.hints} @change=${(e: Event) => this.change({ hints: (e.target as HTMLInputElement).checked })} />${m.hints}</label>
            <p class="muted">${m.hintsHint}</p>
            <div class="row">
              <sf-button
                class="reset-hints"
                size="sm"
                variant="secondary"
                @click=${() => {
                  this.dispatchEvent(new CustomEvent('if-reset-hints', { bubbles: true, composed: true }));
                  this.note = m.hintsReset;
                }}
                >${m.resetHints}</sf-button
              >
            </div>
          </div>
        </div>
      </sf-disclosure>`;
  }

  private renderShortcuts(): TemplateResult {
    return html`<sf-shortcut-sheet .groups=${this.shortcuts} empty-label=${m.noShortcuts}></sf-shortcut-sheet>`;
  }

  private renderStorage(): TemplateResult {
    const f = this.facts;
    const usage = f?.usage;
    const quota = f?.quota;
    const share = usage !== undefined && quota !== undefined && quota > 0 ? Math.min(1, usage / quota) : undefined;
    return html`<div class="stack">
        <h3>${m.usage}</h3>
        ${usage === undefined
          ? html`<p class="muted">${m.unknown}</p>`
          : html`<p class="used">${quota === undefined ? fill(m.used, { used: bytes(usage) }) : fill(m.usedOf, { used: bytes(usage), quota: bytes(quota) })}</p>
              ${share === undefined ? nothing : html`<div class="bar" role="img" aria-label=${`${Math.round(share * 100)} %`}><span style=${`inline-size:${Math.max(1, share * 100)}%`}></span></div>`}`}
      </div>
      <div class="stack">
        <p class="persistence">${f?.persisted === true ? m.persisted : m.notPersisted}</p>
        ${f?.persisted === true ? nothing : html`<div class="row"><sf-button class="keep" size="sm" variant="secondary" @click=${() => void this.keep()}>${m.keep}</sf-button></div>`}
        ${f?.refused === true ? html`<p class="muted refused" role="status">${m.refused}</p>` : nothing}
      </div>
      <div class="stack">
        <p class="muted">${m.trash}</p>
        <div class="row"><sf-button class="open-trash" size="sm" variant="ghost" @click=${() => this.dispatchEvent(new CustomEvent('if-open-trash', { bubbles: true, composed: true }))}>${m.openTrash}</sf-button></div>
      </div>`;
  }

  private async keep(): Promise<void> {
    const granted = await this.storage?.persist?.().catch(() => false);
    this.facts = { ...this.facts, persisted: granted === true, refused: granted !== true };
  }

  private renderAbout(): TemplateResult {
    return html`<dl>
        <dt>${m.version}</dt>
        <dd class="mono version">${INSTAFLOW_VERSION}</dd>
      </dl>
      <div class="row">
        <sf-button class="copy-diagnostics" size="sm" variant="secondary" @click=${() => void this.copyDiagnostics()}>${m.copyDiagnostics}</sf-button>
      </div>
      <sf-disclosure variant="more" heading=${m.licences} ?open=${this.pro} ?pinned=${this.pro} key="instaflow/settings/about">
        <dl class="licences">
          ${LICENCES.map((l) => html`<dt>${l.name}</dt><dd>${l.what} · ${l.licence}</dd>`)}
          ${this.userFonts.length === 0 ? nothing : html`<dt>${m.yourFonts}</dt><dd>${this.userFonts.join(', ')} · ${m.yours}</dd>`}
        </dl>
      </sf-disclosure>`;
  }

  private async copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.diagnostics());
      this.note = m.copied;
    } catch {
      this.note = m.copyBlocked;
    }
  }
}

/** The diagnostics text (About): what helps someone help you, no document content. */
export function diagnosticsText(facts: { readonly surface: string; readonly density: string; readonly extra?: Readonly<Record<string, string>> }): string {
  const nav = globalThis.navigator as (Navigator & { gpu?: unknown }) | undefined;
  const lines = [
    `Instaflow ${INSTAFLOW_VERSION}`,
    `Surface: ${facts.surface}`,
    `Density: ${facts.density}`,
    `Browser: ${nav?.userAgent ?? 'unknown'}`,
    `Cross-origin isolated: ${String((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true)}`,
    `WebGPU: ${nav?.gpu === undefined ? 'no' : 'yes'}`,
    ...Object.entries(facts.extra ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];
  return lines.join('\n');
}

export function defineSettings(registry: CustomElementRegistry = customElements): void {
  defineButton(registry);
  defineDisclosure(registry);
  defineSegmented(registry);
  defineShortcutSheet(registry);
  if (registry.get(spec.tag) === undefined) defineComponent(IfSettingsElement, registry);
}

declare global {
  interface HTMLElementTagNameMap {
    'if-settings': IfSettingsElement;
  }
}
