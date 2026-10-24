/**
 * The browser surface a11y services touch, injected so services work (and
 * degrade) without a DOM — workers, embedded hosts, tests.
 */
import { defineError } from '@staticflux/core';

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface A11yEnvironment {
  readonly document: Document | undefined;
  readonly matchMedia: ((query: string) => MediaQueryList) | undefined;
  readonly timers: Timers;
  /** `Mod` = ⌘ on Apple platforms, Ctrl elsewhere. */
  readonly isMac: boolean;
}

export const NoDocumentError = defineError(
  'SF-A11Y-004',
  'unavailable',
  'No DOM document is available in this environment.',
  'Focus and announcements need a document; in workers or headless hosts use the no-op behaviour or provide `A11yEnvironment.document`.',
);

export const defaultTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface NavigatorLike {
  readonly platform?: string;
  readonly userAgent?: string;
  readonly userAgentData?: { readonly platform?: string };
}

/** Feature-detected environment from globals. */
export function browserA11yEnvironment(global: typeof globalThis = globalThis): A11yEnvironment {
  const doc = typeof global.document === 'undefined' ? undefined : global.document;
  const matchMedia = typeof global.matchMedia === 'function' ? global.matchMedia.bind(global) : undefined;
  const nav = (typeof global.navigator === 'undefined' ? undefined : global.navigator) as NavigatorLike | undefined;
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? nav?.userAgent ?? '';
  return { document: doc, matchMedia, timers: defaultTimers, isMac: /mac|iphone|ipad|ipod/i.test(platform) };
}
