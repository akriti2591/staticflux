/**
 * Feature `settings/panel` (chunk `feature:settings`, cheap): theme and locale are
 * user-data slices (`settings/theme`, `settings/locale`) applied to the appearance
 * controller (`@staticflux/ui/theme`) and the i18n service; density (Focus / Standard / Pro)
 * is an appearance preference remembered per device; the workspace switch (expert mode) is
 * gated. Every choice is a kit segmented control (APG radio group).
 */
import { ok, token, unit, watch } from '@staticflux/core';
import { type SliceHandle, UserDataToken } from '@staticflux/data';
import { I18nToken } from '@staticflux/i18n';
import { defineFeatureModule } from '@staticflux/runtime';
import { defineSegmented, type SegmentOption } from '@staticflux/kit/segmented';
import { WorkspaceManagerToken } from '@staticflux/shell';
import { component, type ComponentHooksOf, defineComponent, SfElement } from '@staticflux/ui';
import { type AppearancePreference, AppearanceToken, type Density, themeTokens as t } from '@staticflux/ui/theme';
import { css, html, type TemplateResult } from 'lit';
import { ReadinessToken } from '../../adapters/perf-runtime.js';
import { Features, LocaleSlice, ThemeSlice } from '../../app/contracts.js';
import { mountFeatureRoot } from '../../ui/feature-root.js';

type ThemeMode = 'system' | 'light' | 'dark' | 'high-contrast';

const THEMES: readonly SegmentOption<ThemeMode>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'high-contrast', label: 'High contrast' },
];
const DENSITIES: readonly SegmentOption<Density>[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'standard', label: 'Standard' },
  { value: 'pro', label: 'Pro' },
];

/** The theme slice's mode as an appearance preference (high contrast = `contrast: more`). */
export function appearanceForMode(mode: ThemeMode): Pick<AppearancePreference, 'scheme' | 'contrast'> {
  if (mode === 'high-contrast') return { scheme: 'system', contrast: 'more' };
  return { scheme: mode, contrast: 'system' };
}

// Slices are registered once per activation (never inside render: registration mutates observables).
const ThemeSliceToken = /* @__PURE__ */ token('settings/theme-slice').type<SliceHandle<{ readonly mode: ThemeMode }>>();
const LocaleSliceToken = /* @__PURE__ */ token('settings/locale-slice').type<SliceHandle<{ readonly locale: string }>>();
const themeSliceUnit = unit({
  id: 'settings/theme-slice-unit',
  provides: ThemeSliceToken,
  scope: 'feature',
  deps: { required: { userData: UserDataToken } },
  create: ({ userData }) => userData.slice(ThemeSlice),
});
const localeSliceUnit = unit({
  id: 'settings/locale-slice-unit',
  provides: LocaleSliceToken,
  scope: 'feature',
  deps: { required: { userData: UserDataToken } },
  create: ({ userData }) => userData.slice(LocaleSlice),
});

const settingsSpec = component({
  tag: 'studio-settings',
  deps: { render: { theme: ThemeSliceToken, locale: LocaleSliceToken, i18n: I18nToken, workspaces: WorkspaceManagerToken, readiness: ReadinessToken, appearance: AppearanceToken } },
});

class StudioSettings extends SfElement<typeof settingsSpec> {
  static override readonly spec = settingsSpec;
  static override styles = css`
    :host { display: grid; gap: ${t.space.lg.css}; max-inline-size: 60ch; }
    section { display: grid; gap: ${t.space.xs.css}; justify-items: start; }
    h2 { margin: 0; font-size: ${t.type.sizeSm.css}; font-weight: ${t.font.weightSemibold.css}; color: ${t.color.textMuted.css}; }
  `;

  protected override wireDeps(on: ComponentHooksOf<typeof settingsSpec>): void {
    on.onReady('readiness', (readiness) => readiness.rendered(Features.settings.id, this));
  }

  override render(): TemplateResult {
    const { theme, locale, i18n, workspaces, appearance } = this.deps;
    const change = <V extends string>(apply: (value: V) => void) => (e: CustomEvent<{ value: V }>) => apply(e.detail.value);
    return html`
      <h1>Settings</h1>
      <section>
        <h2>Theme</h2>
        <sf-segmented label="Theme" .options=${THEMES} .value=${theme.value.mode} @sf-change=${change<ThemeMode>((mode) => theme.set({ mode }))}></sf-segmented>
      </section>
      <section>
        <h2>Density</h2>
        <sf-segmented label="Density" .options=${DENSITIES} .value=${appearance.preference.density} @sf-change=${change<Density>((density) => void appearance.set({ density }))}></sf-segmented>
      </section>
      <section>
        <h2>Language</h2>
        <sf-segmented
          label="Language"
          .options=${i18n.available.map((code) => ({ value: code, label: code }))}
          .value=${i18n.locale}
          @sf-change=${change<string>((code) => locale.set({ locale: code }))}
        ></sf-segmented>
      </section>
      <section>
        <h2>Workspace</h2>
        <sf-segmented
          label="Workspace"
          .options=${workspaces.workspaces.map((ws) => ({ value: ws.id, label: ws.label }))}
          .value=${workspaces.current.id}
          @sf-change=${change<string>((id) => void workspaces.switchTo(id as Parameters<typeof workspaces.switchTo>[0]))}
        ></sf-segmented>
      </section>
    `;
  }
}

export default defineFeatureModule({
  units: [themeSliceUnit, localeSliceUnit],
  async activate(context) {
    const [themeSliceResult, localeSliceResult, appearance, i18n] = await Promise.all([
      context.injector.get(ThemeSliceToken),
      context.injector.get(LocaleSliceToken),
      context.injector.get(AppearanceToken),
      context.injector.get(I18nToken),
    ]);
    if (!themeSliceResult.ok) return themeSliceResult;
    if (!localeSliceResult.ok) return localeSliceResult;
    const themeSlice = themeSliceResult.value;
    const localeSlice = localeSliceResult.value;
    // Slices are the source of truth; apply them to the appearance and the locale.
    watch(() => themeSlice.value.mode, (mode) => appearance.ok && void appearance.value.set(appearanceForMode(mode), context.signal), { scope: context.scope });
    watch(() => localeSlice.value.locale, (code) => i18n.ok && void i18n.value.setLocale(code, context.signal), { scope: context.scope });
    return ok();
  },
  async mount(context) {
    defineSegmented();
    if (customElements.get(settingsSpec.tag) === undefined) defineComponent(StudioSettings);
    await mountFeatureRoot(context, () => html`<studio-settings></studio-settings>`);
    return ok();
  },
});
