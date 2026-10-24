/**
 * Feature `settings/panel` (chunk `feature:settings`, cheap): theme and locale are
 * user-data slices (`settings/theme`, `settings/locale`) applied to the shell theme
 * controller and the i18n service; the workspace switch (expert mode) is gated.
 */
import { ok, token, unit, watch } from '@staticflux/core';
import { type SliceHandle, UserDataToken } from '@staticflux/data';
import { I18nToken } from '@staticflux/i18n';
import { defineFeatureModule } from '@staticflux/runtime';
import { ThemeControllerToken, type ThemePreference, WorkspaceManagerToken } from '@staticflux/shell';
import { component, type ComponentHooksOf, defineComponent, SfElement } from '@staticflux/ui';
import { css, html, type TemplateResult } from 'lit';
import { ReadinessToken } from '../../adapters/perf-runtime.js';
import { Features, LocaleSlice, ThemeSlice } from '../../app/contracts.js';
import { mountFeatureRoot } from '../../ui/feature-root.js';

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark', 'high-contrast'];

// Slices are registered once per activation (never inside render: registration mutates observables).
const ThemeSliceToken = /* @__PURE__ */ token('settings/theme-slice').type<SliceHandle<{ readonly mode: ThemePreference }>>();
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
  deps: { render: { theme: ThemeSliceToken, locale: LocaleSliceToken, i18n: I18nToken, workspaces: WorkspaceManagerToken, readiness: ReadinessToken } },
});

class StudioSettings extends SfElement<typeof settingsSpec> {
  static override readonly spec = settingsSpec;
  static override styles = css`:host { display: grid; gap: 16px; max-inline-size: 40ch; } fieldset { display: grid; gap: 6px; }`;

  protected override wireDeps(on: ComponentHooksOf<typeof settingsSpec>): void {
    on.onReady('readiness', (readiness) => readiness.rendered(Features.settings.id, this));
  }

  override render(): TemplateResult {
    const { theme, locale, i18n, workspaces } = this.deps;
    return html`
      <h1>Settings</h1>
      <fieldset>
        <legend>Theme</legend>
        ${THEMES.map((mode) => html`<label><input type="radio" name="theme" .checked=${theme.value.mode === mode} @change=${() => theme.set({ mode })} /> ${mode}</label>`)}
      </fieldset>
      <fieldset>
        <legend>Language</legend>
        <select aria-label="Language" @change=${(e: Event) => locale.set({ locale: (e.target as HTMLSelectElement).value })}>
          ${i18n.available.map((code) => html`<option value=${code} ?selected=${i18n.locale === code}>${code}</option>`)}
        </select>
      </fieldset>
      <fieldset>
        <legend>Workspace</legend>
        ${workspaces.workspaces.map(
          (ws) => html`<label><input type="radio" name="workspace" .checked=${workspaces.current.id === ws.id} @change=${() => void workspaces.switchTo(ws.id)} /> ${ws.label}</label>`,
        )}
      </fieldset>
    `;
  }
}

export default defineFeatureModule({
  units: [themeSliceUnit, localeSliceUnit],
  async activate(context) {
    const [themeSliceResult, localeSliceResult, theme, i18n] = await Promise.all([
      context.injector.get(ThemeSliceToken),
      context.injector.get(LocaleSliceToken),
      context.injector.get(ThemeControllerToken),
      context.injector.get(I18nToken),
    ]);
    if (!themeSliceResult.ok) return themeSliceResult;
    if (!localeSliceResult.ok) return localeSliceResult;
    const themeSlice = themeSliceResult.value;
    const localeSlice = localeSliceResult.value;
    // Slices are the source of truth; apply them to the shell theme and the locale.
    watch(() => themeSlice.value.mode, (mode) => theme.ok && void theme.value.set(mode, context.signal), { scope: context.scope });
    watch(() => localeSlice.value.locale, (code) => i18n.ok && void i18n.value.setLocale(code, context.signal), { scope: context.scope });
    return ok();
  },
  async mount(context) {
    if (customElements.get(settingsSpec.tag) === undefined) defineComponent(StudioSettings);
    await mountFeatureRoot(context, () => html`<studio-settings></studio-settings>`);
    return ok();
  },
});
