/**
 * Shell presets (R18.4, R18.5, R12.10): the layout grid per app profile
 * (host mode × form factor). Boot plans pick a preset by binding `ShellPresetToken`;
 * the shell never branches on the mode itself.
 */
import { token, unit } from '@staticflux/core';
import type { SlotId } from './slots.js';

export type ShellPresetId = `${string}/${string}`;

export interface ShellPreset {
  readonly kind: 'shell-preset';
  readonly id: ShellPresetId;
  /** Regions rendered, in DOM (reading/focus) order. */
  readonly regions: readonly SlotId[];
  /** CSS grid: `grid-template-areas` rows use slot ids as area names. */
  readonly areas: readonly string[];
  readonly columns: string;
  readonly rows: string;
  /** Skip-link targets in link order (default `DEFAULT_SKIP_TARGETS`: main, sidebar, panel); only rendered regions are offered. */
  readonly skipTargets?: readonly SlotId[];
}

/* @__NO_SIDE_EFFECTS__ */
export function defineShellPreset(init: Omit<ShellPreset, 'kind'>): ShellPreset {
  return Object.freeze({ ...init, kind: 'shell-preset' });
}

export const expandedPreset = defineShellPreset({
  id: 'shell/expanded',
  regions: ['header', 'sidebar', 'main', 'panel'],
  areas: ['header header header', 'sidebar main panel'],
  columns: 'minmax(200px, 260px) minmax(0, 1fr) auto',
  rows: 'auto minmax(0, 1fr)',
});

export const mediumPreset = defineShellPreset({
  id: 'shell/medium',
  regions: ['header', 'sidebar', 'main', 'panel'],
  areas: ['header header', 'sidebar main', 'sidebar panel'],
  columns: 'minmax(56px, 72px) minmax(0, 1fr)',
  rows: 'auto minmax(0, 1fr) auto',
});

export const compactPreset = defineShellPreset({
  id: 'shell/compact',
  regions: ['header', 'main', 'panel', 'sidebar'],
  areas: ['header', 'main', 'panel', 'sidebar'],
  columns: 'minmax(0, 1fr)',
  rows: 'auto minmax(0, 1fr) auto auto',
});

/** Embedded hosts (iframe / agent host): no app chrome, main only. */
export const embeddedPreset = defineShellPreset({
  id: 'shell/embedded',
  regions: ['main'],
  areas: ['main'],
  columns: 'minmax(0, 1fr)',
  rows: 'minmax(0, 1fr)',
});

export const shellPresets = { expanded: expandedPreset, medium: mediumPreset, compact: compactPreset, embedded: embeddedPreset } as const;

export const ShellPresetToken = /* @__PURE__ */ token('shell/preset').type<ShellPreset>();

/** Bind the preset of a boot plan / profile. */
/* @__NO_SIDE_EFFECTS__ */
export function shellPresetUnit(preset: ShellPreset) {
  return unit({
    id: 'shell/preset-unit',
    provides: ShellPresetToken,
    scope: 'app',
    create: () => preset,
    description: `Shell layout preset ${preset.id}.`,
  });
}
