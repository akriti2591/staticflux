/**
 * Workspaces (R13.2): declarative config that rearranges, adds, removes and swaps
 * slot contributions (e.g. the `expert` workspace adds the inspector panel). May be
 * gated. Feature swaps are declared as data (`features`) for the app/feature host to
 * act on in `onSwitch` — the shell never imports features.
 *
 * ```ts
 * export const expertWorkspace = defineWorkspace({
 *   id: 'studio/expert', label: 'Expert',
 *   gate: gateResource('workspace', 'workspace:studio/expert'),
 *   add: ['studio/inspector'],
 *   swap: { 'studio/basic-toolbar': 'studio/pro-toolbar' },
 *   move: { 'agent/chat-panel': 'sidebar' },
 * });
 * ```
 */
import { box, contribution, createNoopTelemetry, err, ok, type Result, type Telemetry, token } from '@staticflux/core';
import type { KeyValuePort } from '@staticflux/messaging';
import { allowAllDecide, type DecidePort, type GateResource } from '@staticflux/ui';
import { DuplicateContributionError, UnknownWorkspaceError, WorkspaceDeniedError } from './errors.js';
import type { ContributionId, SlotContribution, SlotId } from './slots.js';
import { SHELL_SUBSYSTEM } from './telemetry.js';

export type WorkspaceId = `${string}/${string}`;

export interface WorkspaceDef {
  readonly kind: 'workspace';
  readonly id: WorkspaceId;
  readonly label: string;
  readonly gate?: GateResource;
  /** Opt-in contributions (`byDefault: false`) shown in this workspace. */
  readonly add?: readonly ContributionId[];
  /** Contributions hidden in this workspace. */
  readonly remove?: readonly ContributionId[];
  /** Replace contribution A by contribution B (B takes A's place unless B moved). */
  readonly swap?: Readonly<Record<ContributionId, ContributionId>>;
  /** Move contributions to another slot. */
  readonly move?: Readonly<Record<ContributionId, SlotId>>;
  /** Order overrides within slots. */
  readonly order?: Readonly<Record<ContributionId, number>>;
  /** Features this workspace swaps in/out (data for the app's onSwitch handler). */
  readonly features?: { readonly mount?: readonly `${string}/${string}`[]; readonly unmount?: readonly `${string}/${string}`[] };
}

/* @__NO_SIDE_EFFECTS__ */
export function defineWorkspace(init: Omit<WorkspaceDef, 'kind' | 'label'> & { readonly label?: string }): WorkspaceDef {
  return Object.freeze({ ...init, kind: 'workspace', label: init.label ?? init.id });
}

export const defaultWorkspace = defineWorkspace({ id: 'shell/default', label: 'Default' });

export type SlotLayout = ReadonlyMap<SlotId, readonly SlotContribution[]>;

/**
 * Pure arrangement: which contributions go where under `workspace`.
 * `allowed(contribution)` filters gated contributions (default: all allowed).
 */
export function arrangeSlots(
  contributions: readonly SlotContribution[],
  workspace: WorkspaceDef = defaultWorkspace,
  allowed: (contribution: SlotContribution) => boolean = () => true,
): SlotLayout {
  const byId = new Map(contributions.map((c) => [c.id, c] as const));
  const added = new Set(workspace.add ?? []);
  const removed = new Set(workspace.remove ?? []);
  const swaps = workspace.swap ?? {};
  const swappedIn = new Set(Object.values(swaps));
  const out = new Map<SlotId, { item: SlotContribution; order: number }[]>();
  const place = (item: SlotContribution, slotOf: SlotContribution, orderOf: SlotContribution): void => {
    const slot = workspace.move?.[item.id] ?? slotOf.slot;
    const order = workspace.order?.[item.id] ?? orderOf.order ?? 0;
    const list = out.get(slot) ?? [];
    list.push({ item, order });
    out.set(slot, list);
  };
  for (const item of contributions) {
    if (removed.has(item.id)) continue;
    const replacementId = swaps[item.id];
    if (replacementId !== undefined) {
      const replacement = byId.get(replacementId);
      if (replacement !== undefined && !removed.has(replacement.id) && allowed(replacement)) place(replacement, item, item);
      continue;
    }
    if (swappedIn.has(item.id)) continue; // placed where the swapped-out item was
    const visible = (item.byDefault ?? true) || added.has(item.id);
    if (!visible || !allowed(item)) continue;
    place(item, item, item);
  }
  const sorted = new Map<SlotId, readonly SlotContribution[]>();
  for (const [slot, list] of out) {
    sorted.set(
      slot,
      list.sort((a, b) => a.order - b.order).map((entry) => entry.item),
    );
  }
  return sorted;
}

export interface WorkspaceSwitch {
  readonly from: WorkspaceDef;
  readonly to: WorkspaceDef;
}

export interface WorkspaceManager {
  /** Reactive. */
  readonly current: WorkspaceDef;
  readonly workspaces: readonly WorkspaceDef[];
  /** Gate-checked switch; persists the preference. */
  switchTo(id: WorkspaceId, signal?: AbortSignal): Promise<Result<WorkspaceDef>>;
  /** Restore the persisted preference (falls back to the initial workspace if gone or denied). */
  restore(signal?: AbortSignal): Promise<Result<WorkspaceDef>>;
  onSwitch(listener: (change: WorkspaceSwitch) => void): () => void;
}

export interface WorkspaceManagerOptions {
  readonly workspaces: readonly WorkspaceDef[];
  readonly initial?: WorkspaceId;
  readonly decide?: DecidePort;
  /** Preference persistence (async; AsyncStore-compatible). */
  readonly store?: KeyValuePort<string>;
  readonly telemetry?: Telemetry;
}

export const WORKSPACE_PREFERENCE_KEY = 'shell/workspace';

export function createWorkspaceManager(options: WorkspaceManagerOptions): Result<WorkspaceManager> {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const decide = options.decide ?? allowAllDecide;
  const list = options.workspaces.some((w) => w.id === defaultWorkspace.id)
    ? options.workspaces
    : [defaultWorkspace, ...options.workspaces];
  const byId = new Map<WorkspaceId, WorkspaceDef>();
  for (const workspace of list) {
    if (byId.has(workspace.id)) return err(DuplicateContributionError({ details: { workspace: workspace.id } }));
    byId.set(workspace.id, workspace);
  }
  const initial = byId.get(options.initial ?? defaultWorkspace.id);
  if (initial === undefined) return err(UnknownWorkspaceError({ details: { workspace: options.initial ?? '' } }));
  const current = box<WorkspaceDef>(initial);
  const listeners = new Set<(change: WorkspaceSwitch) => void>();

  const authorize = async (workspace: WorkspaceDef, signal?: AbortSignal): Promise<Result<void>> => {
    if (workspace.gate === undefined) return ok();
    const verdict = await decide.decide(workspace.gate, signal);
    return verdict.effect === 'allow' ? ok() : err(WorkspaceDeniedError({ details: { workspace: workspace.id, reason: verdict.reason } }));
  };

  const apply = (to: WorkspaceDef): void => {
    const from = current.get();
    if (from === to) return;
    current.set(to);
    telemetry.event('shell.workspace.switched', { subsystem: SHELL_SUBSYSTEM, level: 'standard', attrs: { from: from.id, to: to.id } });
    for (const listener of [...listeners]) listener({ from, to });
  };

  return ok({
    get current() {
      return current.get();
    },
    workspaces: list,
    async switchTo(id, signal) {
      const workspace = byId.get(id);
      if (workspace === undefined) return err(UnknownWorkspaceError({ details: { workspace: id } }));
      const allowed = await authorize(workspace, signal);
      if (!allowed.ok) return allowed;
      apply(workspace);
      if (options.store !== undefined) {
        const saved = await options.store.set(WORKSPACE_PREFERENCE_KEY, id, signal === undefined ? {} : { signal });
        if (!saved.ok) {
          telemetry.event('shell.workspace.persist-failed', { subsystem: SHELL_SUBSYSTEM, level: 'standard', attrs: { code: saved.error.code } });
        }
      }
      return ok(workspace);
    },
    async restore(signal) {
      if (options.store === undefined) return ok(current.get());
      const stored = await options.store.get(WORKSPACE_PREFERENCE_KEY, signal === undefined ? {} : { signal });
      if (!stored.ok || stored.value === undefined) return ok(current.get());
      const workspace = byId.get(stored.value as WorkspaceId);
      if (workspace === undefined) return ok(current.get());
      const allowed = await authorize(workspace, signal);
      if (!allowed.ok) return ok(current.get());
      apply(workspace);
      return ok(workspace);
    },
    onSwitch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

/** Multi token: workspaces contributed by packages/features. */
export const WorkspacesToken = /* @__PURE__ */ token('shell/workspaces').multi<WorkspaceDef>();
export const WorkspaceManagerToken = /* @__PURE__ */ token('shell/workspace-manager').type<WorkspaceManager>();
/** Workspace preference persistence (optional binding; AsyncStore-compatible). */
export const WorkspacePreferenceStoreToken = /* @__PURE__ */ token('shell/workspace-preference-store').type<KeyValuePort<string>>();

/* @__NO_SIDE_EFFECTS__ */
export function workspaceContribution(workspace: WorkspaceDef) {
  return contribution({
    id: `${workspace.id}-workspace`,
    provides: WorkspacesToken,
    scope: 'app',
    create: () => workspace,
  });
}
