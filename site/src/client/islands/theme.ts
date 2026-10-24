/**
 * Island `island:theme` — the header theme switch. The buttons are prerendered (and
 * clickable before hydration: the hydrator queues the click and replays it). Hydration
 * only attaches behaviour: everything registers in the island scope.
 */
import { effect, err, ok } from '@staticflux/core';
import { AnnouncerToken } from '@staticflux/a11y';
import { defineIsland } from '@staticflux/hydrate';
import { ThemeControllerToken, type ThemePreference } from '@staticflux/shell';
import { MissingInjectorError } from '../errors.js';

const LABELS: Readonly<Record<string, string>> = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };

const themeIsland = defineIsland({
  async hydrate(element, { injector, scope, signal }) {
    if (injector === undefined) return err(MissingInjectorError());
    const [theme, announcer] = await Promise.all([injector.get(ThemeControllerToken, signal), injector.get(AnnouncerToken, signal)]);
    if (!theme.ok) return theme;
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('[data-theme-pref]')];
    for (const button of buttons) {
      scope.listen(button, 'click', () => {
        const preference = button.dataset['themePref'] as ThemePreference;
        void theme.value.set(preference, signal);
        if (announcer.ok) announcer.value.announce(LABELS[preference] ?? preference);
      });
    }
    // Reactive: re-runs when the preference changes (here or in another island).
    effect(() => {
      const current = theme.value.preference;
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset['themePref'] === current));
    }, scope);
    return ok();
  },
});

/** Island module contract: a named `hydrate` export (no default exports, sf-lint `no-default-export`). */
export const hydrate = themeIsland.hydrate;
