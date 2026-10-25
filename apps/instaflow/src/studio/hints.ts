/**
 * First-use hints (OVERLAYS-FEEDBACK §5, FOUNDATIONS §4.22): no tours, one sentence at the moment of first use.
 *
 * - `STUDIO_HINTS` — the M1 set: Frame, Shape, Text, Hand (Pen when it ships) under the tool picker, Layers' first
 *   element, the first multi-selection; each a `defineHintSurface` with its typed coach target.
 * - `localSeenStore(storage)` — the seen-once store under `instaflow/ui/hints` (`localStorage`, per device). Blocked or
 *   missing storage degrades to this tab's memory (hints may show again next time; nothing breaks).
 * - `createHintSession({ manager, owner, seen, enabled })` — at most **two** hints per session (a tab's life); the third
 *   candidate is simply marked seen. Nothing shows while `enabled()` is false (Settings › General `Show first-use
 *   hints`), in milestone preview or after a deep-linked arrival (`suppress()`). `used(hint)` dismisses a showing hint
 *   when its target is used (counts as seen); `reset()` is Settings' `Reset hints`.
 */
import { ok, type Result } from '@staticflux/core';
import { defineHintSurface } from '@staticflux/kit/surface-defs';
import { createMemoryKeyValue, defineCoachTarget, type KeyValuePort, type SurfaceDef, type SurfaceHandle, type SurfaceManager, type SurfaceOwner } from '@staticflux/messaging';

export const HINTS_STORAGE_PREFIX = 'instaflow/ui/hints';
/** Hints per session (§5). */
export const HINTS_PER_SESSION = 2;

export const HintTargets = Object.freeze({
  frameTool: defineCoachTarget('instaflow/tool-frame'),
  shapeTool: defineCoachTarget('instaflow/tool-shape'),
  textTool: defineCoachTarget('instaflow/tool-text'),
  handTool: defineCoachTarget('instaflow/tool-hand'),
  penTool: defineCoachTarget('instaflow/tool-pen'),
  layers: defineCoachTarget('instaflow/layers-panel'),
  multiSelection: defineCoachTarget('instaflow/selection-pill'),
});

/** The M1 hint set, copy from STUDIO-UX-SPEC §4.1 and OVERLAYS-FEEDBACK §5. Pen waits for its tool. */
export const STUDIO_HINTS = Object.freeze({
  frame: defineHintSurface({ id: 'instaflow/hint-frame', target: HintTargets.frameTool, text: 'Drag to draw a frame. Frames hold other things and clip them.' }),
  shape: defineHintSurface({ id: 'instaflow/hint-shape', target: HintTargets.shapeTool, text: 'Drag to draw. Shift keeps it square, Alt draws from the centre.' }),
  text: defineHintSurface({ id: 'instaflow/hint-text', target: HintTargets.textTool, text: 'Click to start typing, or drag for a fixed width.' }),
  hand: defineHintSurface({ id: 'instaflow/hint-hand', target: HintTargets.handTool, text: 'Drag to pan. Hold Space to pan with any tool.' }),
  layers: defineHintSurface({ id: 'instaflow/hint-layers', target: HintTargets.layers, text: 'Drag rows to reorder; the eye hides, the lock protects.' }),
  multiSelection: defineHintSurface({ id: 'instaflow/hint-multi', target: HintTargets.multiSelection, text: 'Align ▾ lines things up; Group keeps them together.' }),
});

/** The key messaging's seen store uses for a surface. */
export function seenKeyOf(def: SurfaceDef<void, never>): string {
  return `messaging/seen/${def.id}`;
}

/** `localStorage`-backed seen store under `instaflow/ui/hints/…`; memory when storage is blocked or absent. */
export function localSeenStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined, prefix = HINTS_STORAGE_PREFIX): KeyValuePort<boolean> {
  const memory = createMemoryKeyValue<boolean>();
  const key = (k: string): string => `${prefix}/${k}`;
  const attempt = <T>(run: () => T): T | undefined => {
    try {
      return storage === undefined ? undefined : run();
    } catch {
      return undefined; // private mode, quota, blocked site data
    }
  };
  return {
    async get(k) {
      const raw = attempt(() => storage?.getItem(key(k)));
      if (raw === undefined || raw === null) return memory.get(k);
      return ok(raw === '1');
    },
    async set(k, value): Promise<Result<void>> {
      await memory.set(k, value);
      attempt(() => storage?.setItem(key(k), value ? '1' : '0'));
      return ok(undefined);
    },
    async delete(k): Promise<Result<void>> {
      await memory.delete(k);
      attempt(() => storage?.removeItem(key(k)));
      return ok(undefined);
    },
  };
}

export interface HintSession {
  /** Offer a hint; undefined when hints are off, suppressed, or the session cap is reached (then it is marked seen). */
  offer(hint: SurfaceDef<void, never>): SurfaceHandle | undefined;
  /** The target was used: a showing hint goes (seen); a queued one is dropped and marked seen. */
  used(hint: SurfaceDef<void, never>): void;
  /** Deep-linked arrival, milestone preview: no hints until `resume()`. */
  suppress(): void;
  resume(): void;
  /** Settings › General `Reset hints`: forget every seen hint. */
  reset(): Promise<void>;
  readonly shownThisSession: number;
}

export interface HintSessionOptions {
  readonly manager: SurfaceManager;
  readonly owner: SurfaceOwner;
  /** The same store the surface manager was created with (`seen`). */
  readonly seen: KeyValuePort<boolean>;
  /** Settings › General `Show first-use hints` (default on). */
  readonly enabled: () => boolean;
  readonly hints?: readonly SurfaceDef<void, never>[];
  readonly cap?: number;
}

export function createHintSession(options: HintSessionOptions): HintSession {
  const cap = options.cap ?? HINTS_PER_SESSION;
  const all = options.hints ?? Object.values(STUDIO_HINTS);
  const handles = new Map<string, SurfaceHandle>();
  let shown = 0;
  let suppressed = false;
  return {
    offer(hint) {
      if (!options.enabled() || suppressed) return undefined;
      const existing = handles.get(hint.id);
      if (existing !== undefined && existing.state !== 'dismissed' && existing.state !== 'rejected') return existing;
      if (shown >= cap) {
        // The person is clearly exploring: no more hints this session, and this one never comes back.
        void options.seen.set(seenKeyOf(hint), true);
        return undefined;
      }
      const handle = options.manager.request(hint, { owner: options.owner });
      handles.set(hint.id, handle);
      const unsubscribe = options.manager.onTransition((h, _from, to) => {
        if (h === handle && to === 'showing') {
          shown += 1;
          unsubscribe();
        }
      });
      void handle.closed.then(() => unsubscribe());
      return handle;
    },
    used(hint) {
      const handle = handles.get(hint.id);
      if (handle !== undefined) handle.dismiss('completed');
      void options.seen.set(seenKeyOf(hint), true);
    },
    suppress() {
      suppressed = true;
      for (const handle of handles.values()) handle.dismiss('programmatic');
    },
    resume() {
      suppressed = false;
    },
    async reset() {
      for (const hint of all) await options.seen.delete(seenKeyOf(hint));
    },
    get shownThisSession() {
      return shown;
    },
  };
}
