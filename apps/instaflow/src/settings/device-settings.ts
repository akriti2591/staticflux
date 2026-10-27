/**
 * Device settings (B11c; STUDIO-UX-SPEC §2.4, DENSITY-DISCLOSURE §7.1): what this device remembers for Home and Studio
 * alike — the **density** (Focus · Standard · Pro, default Standard), **reduced motion** (follow the system, or force
 * it on or off), the default **units** of New design, and whether **first-use hints** show. Per device, in
 * `localStorage` (`instaflow/ui/settings`; a convenience: blocked storage falls back to this tab), never in a document,
 * a milestone, an export or a URL (NAVIGATION §2.3).
 *
 * The settings are reactive (`current`), follow other tabs (the `storage` event) and are applied to a document root as
 * the theme's appearance attributes (`data-sf-density`, `data-sf-motion`), so every token-driven component follows.
 */
import { box, type Scope, watch } from '@staticflux/core';

export const DEVICE_DENSITIES = ['focus', 'standard', 'pro'] as const;
export type DeviceDensity = (typeof DEVICE_DENSITIES)[number];
export const MOTION_SETTINGS = ['system', 'reduce', 'full'] as const;
export type MotionSetting = (typeof MOTION_SETTINGS)[number];
/** New design's default units (HOME-FILES §1.3: `Units ▾ … default from Settings`). */
export const UNIT_SETTINGS = ['px', 'mm', 'in', 'pt'] as const;
export type UnitSetting = (typeof UNIT_SETTINGS)[number];

export interface DeviceSettingsValue {
  readonly density: DeviceDensity;
  readonly motion: MotionSetting;
  readonly units: UnitSetting;
  /** Show first-use hints (OVERLAYS §5; default on). */
  readonly hints: boolean;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettingsValue = Object.freeze({ density: 'standard', motion: 'system', units: 'px', hints: true });
export const DEVICE_SETTINGS_KEY = 'instaflow/ui/settings';

/** The one-liners every density chooser shows (DENSITY-DISCLOSURE §1). */
export const DENSITY_LINES: Readonly<Record<DeviceDensity, { readonly name: string; readonly line: string }>> = Object.freeze({
  focus: { name: 'Focus', line: 'Just your work.' },
  standard: { name: 'Standard', line: 'Your work, with the panels that explain it.' },
  pro: { name: 'Pro', line: 'Everything, with numbers.' },
});

/** The next density of the `Mod+.` cycle (Focus → Standard → Pro → Focus). */
export function nextDensity(d: DeviceDensity): DeviceDensity {
  return DEVICE_DENSITIES[(DEVICE_DENSITIES.indexOf(d) + 1) % DEVICE_DENSITIES.length] as DeviceDensity;
}

const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback);

/** Settings from stored JSON (tolerant: anything malformed falls back to the default). */
export function parseDeviceSettings(raw: string | null | undefined): DeviceSettingsValue {
  try {
    const v = raw === null || raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
    const d = DEFAULT_DEVICE_SETTINGS;
    return {
      density: pick(DEVICE_DENSITIES, v['density'], d.density),
      motion: pick(MOTION_SETTINGS, v['motion'], d.motion),
      units: pick(UNIT_SETTINGS, v['units'], d.units),
      hints: typeof v['hints'] === 'boolean' ? v['hints'] : d.hints,
    };
  } catch {
    return DEFAULT_DEVICE_SETTINGS;
  }
}

export interface DeviceSettings {
  /** Reactive. */
  readonly current: DeviceSettingsValue;
  set(patch: Partial<DeviceSettingsValue>): void;
  /** Keep `root`'s appearance attributes in step until `scope` ends (and follow other tabs). */
  apply(root: HTMLElement, scope: Scope): void;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The device settings over `storage` (default `localStorage`); `window` for the cross-tab `storage` event. */
export function createDeviceSettings(options: { readonly storage?: StorageLike | null; readonly window?: Pick<Window, 'addEventListener'> | null } = {}): DeviceSettings {
  const storage = options.storage === null ? undefined : (options.storage ?? (globalThis as { localStorage?: StorageLike }).localStorage);
  const read = (): DeviceSettingsValue => {
    try {
      return parseDeviceSettings(storage?.getItem(DEVICE_SETTINGS_KEY));
    } catch {
      return DEFAULT_DEVICE_SETTINGS;
    }
  };
  const value = box<DeviceSettingsValue>(read(), (a, b) => JSON.stringify(a) === JSON.stringify(b));
  return {
    get current() {
      return value.get();
    },
    set(patch) {
      const next = { ...value.get(), ...patch };
      value.set(parseDeviceSettings(JSON.stringify(next)));
      try {
        storage?.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(value.get()));
      } catch {
        // This tab keeps the value (private windows, blocked storage).
      }
    },
    apply(root, scope) {
      watch(
        () => value.get(),
        (s) => {
          root.setAttribute('data-sf-density', s.density);
          if (s.motion === 'system') root.removeAttribute('data-sf-motion');
          else root.setAttribute('data-sf-motion', s.motion);
        },
        { scope, fireImmediately: true },
      );
      const win = options.window === null ? undefined : (options.window ?? (globalThis as { window?: Pick<Window, 'addEventListener'> }).window);
      win?.addEventListener(
        'storage',
        (e) => {
          if ((e as StorageEvent).key === DEVICE_SETTINGS_KEY) value.set(read());
        },
        { signal: scope.signal },
      );
    },
  };
}

