/**
 * Browser entry. Step 1 is the tiny inline mode detector (R12.9, < 1 KB): it picks the
 * app profile (host mode × form factor) before anything else loads, so boot and
 * runtime agree and other modes' code is never fetched. Step 2 boots the app.
 */
import { detectMode } from '@staticflux/platform/detect-mode';

type Detect = Parameters<typeof detectMode>[0];
const g = globalThis as unknown as Record<string, unknown> & { window?: Detect['window']; navigator?: Detect['navigator']; matchMedia?: (q: string) => ReturnType<NonNullable<Detect['matchMedia']>> };
const detected = detectMode({
  window: g.window,
  navigator: g.navigator,
  matchMedia: typeof g.matchMedia === 'function' ? (query) => g.matchMedia!(query) : undefined,
  globals: g,
});
document.documentElement.dataset['sfProfile'] = `${detected.hostMode}:${detected.formFactor}`;

void import('./boot-browser.js').then((boot) => boot.startStudio(detected));
