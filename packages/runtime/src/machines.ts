/**
 * The runtime's lifecycle machines as data (docs/LIFECYCLES.md §1, §2, §6).
 * Keep these tables in sync with the doc — they are the source of truth at runtime.
 */
import { defineMachine } from '@staticflux/core';

// ---------------------------------------------------------------- app (§1)

export const APP_STATES = [
  'starting',
  'core-ready',
  'running',
  'degraded',
  'paused',
  'reinitializing',
  'shutting-down',
  'terminated',
] as const;
export type AppState = (typeof APP_STATES)[number];

export type AppEvent =
  | 'core-ready'
  | 'run'
  | 'degrade'
  | 'recover'
  | 'pause'
  | 'resume'
  | 'reinitialize'
  | 'shutdown'
  | 'terminate';

export const appMachine = defineMachine<AppState, AppEvent>({
  id: 'app',
  initial: 'starting',
  states: APP_STATES,
  transitions: {
    starting: { 'core-ready': 'core-ready', shutdown: 'shutting-down' },
    'core-ready': { run: 'running', shutdown: 'shutting-down' },
    running: { degrade: 'degraded', pause: 'paused', reinitialize: 'reinitializing', shutdown: 'shutting-down' },
    degraded: { recover: 'running', pause: 'paused', reinitialize: 'reinitializing', shutdown: 'shutting-down' },
    paused: { resume: 'running', reinitialize: 'reinitializing', shutdown: 'shutting-down' },
    reinitializing: { 'core-ready': 'core-ready', shutdown: 'shutting-down' },
    'shutting-down': { terminate: 'terminated' },
  },
  terminal: ['terminated'],
});

/** App-wide commands (R4.3). `abort` and `refresh` are not states. */
export const APP_COMMANDS = ['pause', 'resume', 'abort', 'refresh', 'reinitialize', 'shutdown'] as const;
export type AppCommand = (typeof APP_COMMANDS)[number];

/** Commands allowed per app state (docs/LIFECYCLES.md §1 table). */
export const ALLOWED_COMMANDS: { readonly [S in AppState]: readonly AppCommand[] } = {
  starting: ['abort', 'shutdown'],
  'core-ready': [],
  running: ['pause', 'refresh', 'reinitialize', 'shutdown', 'abort'],
  degraded: ['pause', 'refresh', 'reinitialize', 'shutdown', 'abort'],
  paused: ['resume', 'shutdown'],
  reinitializing: [],
  'shutting-down': [],
  terminated: [],
};

// ---------------------------------------------------------------- subsystem (§2)

export const SUBSYSTEM_STATES = [
  'idle',
  'starting',
  'running',
  'paused',
  'failed',
  'restarting',
  'given-up',
  'stopping',
  'stopped',
] as const;
export type SubsystemState = (typeof SUBSYSTEM_STATES)[number];

export type SubsystemEvent = 'start' | 'started' | 'pause' | 'resume' | 'fail' | 'restart' | 'give-up' | 'stop' | 'stopped';

export const subsystemMachine = defineMachine<SubsystemState, SubsystemEvent>({
  id: 'subsystem',
  initial: 'idle',
  states: SUBSYSTEM_STATES,
  transitions: {
    idle: { start: 'starting', stop: 'stopping' },
    starting: { started: 'running', fail: 'failed', stop: 'stopping' },
    running: { pause: 'paused', fail: 'failed', stop: 'stopping' },
    paused: { resume: 'running', fail: 'failed', stop: 'stopping' },
    failed: { restart: 'restarting', 'give-up': 'given-up', stop: 'stopping' },
    restarting: { start: 'starting', stop: 'stopping' },
    'given-up': { stop: 'stopping' },
    stopping: { stopped: 'stopped' },
    // reinitialize re-boots stopped subsystems
    stopped: { start: 'starting' },
  },
});

// ---------------------------------------------------------------- feature (§6)

export const FEATURE_STATES = [
  'declared',
  'loading',
  'loaded',
  'activating',
  'activated',
  'mounting',
  'mounted',
  'hidden',
  'unmounting',
  'deactivating',
  'archived',
  'evicted',
  'failed',
] as const;
export type FeatureState = (typeof FEATURE_STATES)[number];

export type FeatureEvent =
  | 'load'
  | 'loaded'
  | 'activate'
  | 'activated'
  | 'mount'
  | 'mounted'
  | 'mount-failed'
  | 'hide'
  | 'show'
  | 'unmount'
  | 'unmounted'
  | 'deactivate'
  | 'deactivated'
  | 'archive'
  | 'evict'
  | 'fail'
  | 'retry-load'
  | 'retry-activate';

export const featureMachine = defineMachine<FeatureState, FeatureEvent>({
  id: 'feature',
  initial: 'declared',
  states: FEATURE_STATES,
  transitions: {
    declared: { load: 'loading' },
    loading: { loaded: 'loaded', fail: 'failed' },
    loaded: { activate: 'activating', archive: 'archived', evict: 'evicted' },
    activating: { activated: 'activated', fail: 'failed' },
    activated: { mount: 'mounting', deactivate: 'deactivating' },
    // a failed mount() leaves logic warm (back to activated)
    mounting: { mounted: 'mounted', 'mount-failed': 'activated' },
    mounted: { hide: 'hidden', unmount: 'unmounting' },
    hidden: { show: 'mounted', unmount: 'unmounting' },
    unmounting: { unmounted: 'activated' },
    deactivating: { deactivated: 'loaded' },
    // rehydrate from snapshot; evict drops the snapshot as well
    archived: { activate: 'activating', evict: 'evicted' },
    // cheap features are recreated on next use
    evicted: { load: 'loading' },
    failed: { 'retry-load': 'loading', 'retry-activate': 'activating', evict: 'evicted' },
  },
});

/** Feature states in which the logic (feature injector + logic scope) is alive. */
export const LOGIC_ALIVE_STATES: readonly FeatureState[] = ['activated', 'mounting', 'mounted', 'hidden', 'unmounting'];
/** Feature states in which UI is mounted (I-5 requires logic alive in all of them). */
export const UI_MOUNTED_STATES: readonly FeatureState[] = ['mounting', 'mounted', 'hidden', 'unmounting'];
