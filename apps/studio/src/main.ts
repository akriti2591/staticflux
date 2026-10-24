/**
 * Browser entry. Step 1 is the tiny inline mode detector (R12.9, < 1 KB): it picks the
 * app profile (host mode × form factor) before anything else loads, so boot and
 * runtime agree and other modes' code is never fetched. Step 2 boots the app.
 */
import { browserEnv, detectMode } from '@staticflux/platform/detect-mode';

const detected = detectMode(browserEnv());
document.documentElement.dataset['sfProfile'] = `${detected.hostMode}:${detected.formFactor}`;

void import('./boot-browser.js').then((boot) => boot.startStudio(detected));
