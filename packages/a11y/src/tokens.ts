/**
 * DI tokens of @staticflux/a11y — no implementation imports, so boot code can name a token
 * whose provider loads later (e.g. a deferred keyboard chunk) without bundling it.
 */
import { token } from '@staticflux/core';
import type { Announcer } from './announcer.js';
import type { A11yEnvironment } from './env.js';
import type { FocusManager } from './focus.js';
import type { PreferenceFacts } from './preferences.js';
import type { ShortcutRegistry } from './shortcuts.js';

export const A11yEnvironmentToken = /* @__PURE__ */ token('a11y/environment').type<A11yEnvironment>();
export const FocusManagerToken = /* @__PURE__ */ token('a11y/focus-manager').type<FocusManager>();
export const AnnouncerToken = /* @__PURE__ */ token('a11y/announcer').type<Announcer>();
export const ShortcutRegistryToken = /* @__PURE__ */ token('a11y/shortcuts').type<ShortcutRegistry>();
export const PreferenceFactsToken = /* @__PURE__ */ token('a11y/preferences').type<PreferenceFacts>();
