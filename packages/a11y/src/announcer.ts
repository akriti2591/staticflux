/**
 * Live-region announcer (R15.2): one polite (`role=status`) and one assertive
 * (`role=alert`) visually-hidden region, created lazily. Messages arriving
 * within the debounce window are coalesced (deduplicated, in order) so a burst
 * of updates is read once. Regions are cleared after `clearAfterMs` so stale
 * text is not found later by virtual cursors. Message text never goes to
 * telemetry (privacy); only politeness and length do.
 */
import { createNoopTelemetry, type Telemetry } from '@staticflux/core';
import { defaultTimers, type Timers } from './env.js';
import { KEEP_INTERACTIVE_ATTR } from './focus.js';

export type Politeness = 'polite' | 'assertive';

export interface AnnounceOptions {
  readonly politeness?: Politeness;
  /** Drop a message identical to one already pending. Default true. */
  readonly dedupe?: boolean;
}

export interface Announcer {
  announce(message: string, options?: AnnounceOptions): void;
  /** Flush pending messages now. */
  flush(): void;
  /** Clear both regions and drop pending messages. */
  clear(): void;
  /** Current region text (devtools/tests). */
  text(politeness: Politeness): string;
  dispose(): void;
}

export interface AnnouncerOptions {
  readonly document: Document | undefined;
  readonly timers?: Timers;
  /** Coalescing window per politeness. Default polite 150 ms, assertive 0 (immediate). */
  readonly debounceMs?: Partial<Readonly<Record<Politeness, number>>>;
  /** Clear region text after this long. Default 7000 ms; 0 disables. */
  readonly clearAfterMs?: number;
  readonly telemetry?: Telemetry;
  /** Where regions are appended. Default `document.body`. */
  readonly container?: Element;
}

export const LIVE_REGION_ATTR = 'data-sf-live-region';

const VISUALLY_HIDDEN =
  'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;';

interface Channel {
  region: HTMLElement | undefined;
  pending: string[];
  debounceTimer: unknown;
  clearTimer: unknown;
}

export function createAnnouncer(options: AnnouncerOptions): Announcer {
  const doc = options.document;
  const timers = options.timers ?? defaultTimers;
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const debounce: Record<Politeness, number> = { polite: 150, assertive: 0, ...options.debounceMs };
  const clearAfterMs = options.clearAfterMs ?? 7000;
  const channels: Record<Politeness, Channel> = {
    polite: { region: undefined, pending: [], debounceTimer: undefined, clearTimer: undefined },
    assertive: { region: undefined, pending: [], debounceTimer: undefined, clearTimer: undefined },
  };
  let disposed = false;

  const regionFor = (politeness: Politeness): HTMLElement | undefined => {
    const channel = channels[politeness];
    if (channel.region?.isConnected === true) return channel.region;
    if (doc === undefined) return undefined;
    const parent = options.container ?? doc.body;
    if (parent === null) return undefined;
    const region = doc.createElement('div');
    region.setAttribute(LIVE_REGION_ATTR, politeness);
    region.setAttribute(KEEP_INTERACTIVE_ATTR, '');
    region.setAttribute('aria-live', politeness);
    region.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
    region.setAttribute('aria-atomic', 'true');
    region.setAttribute('style', VISUALLY_HIDDEN);
    parent.appendChild(region);
    channel.region = region;
    return region;
  };

  const write = (politeness: Politeness): void => {
    const channel = channels[politeness];
    if (channel.debounceTimer !== undefined) timers.clear(channel.debounceTimer);
    channel.debounceTimer = undefined;
    if (channel.pending.length === 0) return;
    const message = channel.pending.join(' ');
    channel.pending = [];
    const region = regionFor(politeness);
    if (region === undefined) return;
    // Re-announcing identical text: vary it invisibly so screen readers notice the change.
    region.textContent = region.textContent === message ? `${message} ` : message;
    telemetry.event('a11y.announce', { subsystem: 'a11y/announcer', level: 'verbose', attrs: { politeness, length: message.length } });
    if (channel.clearTimer !== undefined) timers.clear(channel.clearTimer);
    channel.clearTimer =
      clearAfterMs > 0
        ? timers.set(() => {
            channel.clearTimer = undefined;
            if (channel.region !== undefined) channel.region.textContent = '';
          }, clearAfterMs)
        : undefined;
  };

  const flush = (): void => {
    write('assertive');
    write('polite');
  };

  return {
    announce(message, announceOptions = {}) {
      if (disposed) return;
      const text = message.trim();
      if (text === '') return;
      const politeness = announceOptions.politeness ?? 'polite';
      const channel = channels[politeness];
      if (announceOptions.dedupe !== false && channel.pending.includes(text)) return;
      channel.pending.push(text);
      const delay = debounce[politeness];
      if (delay <= 0) {
        write(politeness);
        return;
      }
      if (channel.debounceTimer !== undefined) timers.clear(channel.debounceTimer);
      channel.debounceTimer = timers.set(() => write(politeness), delay);
    },
    flush,
    clear() {
      for (const channel of Object.values(channels)) {
        channel.pending = [];
        if (channel.debounceTimer !== undefined) timers.clear(channel.debounceTimer);
        if (channel.clearTimer !== undefined) timers.clear(channel.clearTimer);
        channel.debounceTimer = undefined;
        channel.clearTimer = undefined;
        if (channel.region !== undefined) channel.region.textContent = '';
      }
    },
    text(politeness) {
      return channels[politeness].region?.textContent ?? '';
    },
    dispose() {
      if (disposed) return;
      this.clear();
      disposed = true;
      for (const channel of Object.values(channels)) {
        channel.region?.remove();
        channel.region = undefined;
      }
    },
  };
}
