/**
 * Error catalog of @staticflux/runtime. Codes are stable; agents look them up
 * (docs/LIFECYCLES.md §12–§13) instead of guessing.
 */
import { defineError } from '@staticflux/core';

// ---------------------------------------------------------------- app / supervisor

/** I-1: nothing executes in app `paused` except the resume path. */
export const AppPausedError = defineError(
  'SF-APP-001',
  'unavailable',
  'The app is paused; only the resume path may execute (I-1).',
  'Wait with `supervisor.whenRunnable(request, signal)`, or check `supervisor.assertRunnable()` before starting work.',
);

export const CommandNotAllowedError = defineError(
  'SF-APP-002',
  'invariant',
  'The app command is not allowed in the current app state.',
  'Check `supervisor.can(command)` first; docs/LIFECYCLES.md §1 lists the commands allowed per state.',
);

export const CommandDeniedError = defineError(
  'SF-APP-003',
  'forbidden',
  'A feature requested an app-wide command and the command policy denied it.',
  'Features only *request* commands; bind `CommandPolicyToken` in the shell to change what is allowed.',
);

export const SubsystemGaveUpError = defineError(
  'SF-APP-004',
  'unavailable',
  'A subsystem failed more often than its restart intensity allows and was given up.',
  'Inspect `cause` and the restart history in devtools; fix the failure or raise `restart.maxRestarts` with a reason.',
);

export const SubsystemGraphError = defineError(
  'SF-APP-005',
  'invariant',
  'The subsystem dependency graph is invalid (duplicate id, unknown dependency, cycle, or critical → non-critical edge).',
  'Give every subsystem a unique id, declare only registered ids in `dependsOn`, and keep critical subsystems depending on critical ones only.',
);

export const BootFailedError = defineError(
  'SF-APP-006',
  'unavailable',
  'The app could not reach core-ready (a critical unit or critical subsystem failed).',
  'Inspect `cause`. Only units that truly block the first frame should be `critical`; make the rest lazy.',
);

export const AppTerminatedError = defineError(
  'SF-APP-007',
  'aborted',
  'The app is shutting down or terminated.',
  'Expected after shutdown. Do not keep handles to the supervisor beyond app lifetime.',
);

// ---------------------------------------------------------------- features

/** I-5: feature `mounted` ⇒ feature logic `activated`. */
export const MountWithoutLogicError = defineError(
  'SF-FT-001',
  'invariant',
  'A feature UI was mounted while its logic was not activated (I-5).',
  'Call `featureHost.mount(id)` (it activates first) instead of mounting UI directly, or activate the feature before mounting.',
);

/** I-6: a feature cannot deactivate while a dependent feature is mounted. */
export const FeatureInUseError = defineError(
  'SF-FT-002',
  'conflict',
  'A feature cannot deactivate while a dependent feature is mounted (I-6).',
  'Unmount the dependent features first; the resource manager retries demotion once the ref-count drops to zero.',
);

export const FeatureLoadFailedError = defineError(
  'SF-FT-003',
  'unavailable',
  "A feature module failed to load (the manifest's `load()` rejected).",
  'Inspect `cause` (network/chunk error). Activating again retries the load.',
);

export const FeatureActivationFailedError = defineError(
  'SF-FT-004',
  'unavailable',
  "A feature's activation failed (activate(), restore() or a unit of the feature injector failed).",
  'Inspect `cause`. Return a typed Result from activate(); activating again retries.',
);

export const UnknownFeatureError = defineError(
  'SF-FT-005',
  'not-found',
  'No feature with this id is registered in the feature host.',
  'Register the manifest (`featureHost.register(manifest)` or contribute it to `FeatureManifestsToken`) before using it.',
);

export const FeatureDependencyError = defineError(
  'SF-FT-006',
  'unavailable',
  'A feature this feature requires is not registered or could not be activated.',
  'Register every feature listed in `requires.features`; check the dependency feature for its own failure.',
);

export const FeatureGraphError = defineError(
  'SF-FT-007',
  'invariant',
  'Feature `requires.features` declarations form a cycle, or a feature id is registered twice.',
  'Break the cycle by extracting the shared capability into a unit both features consume.',
);

export const FeatureMountFailedError = defineError(
  'SF-FT-008',
  'unavailable',
  "A feature's mount() failed; the feature stays activated (logic warm).",
  'Inspect `cause`; mount() must only render — move fallible work into activate().',
);

export const ArchiveFailedError = defineError(
  'SF-FT-009',
  'unavailable',
  'Persisting or reading a feature snapshot failed.',
  'Check the ArchiveStore backend (quota, private mode). The feature falls back to a fresh activation.',
);

// ---------------------------------------------------------------- scheduler

export const SchedulerDisposedError = defineError(
  'SF-SCHED-001',
  'aborted',
  'The frame scheduler was disposed; the job was dropped.',
  'Expected during shutdown. Do not schedule work on a disposed scheduler.',
);

export const WorkerSchedulerDisposedError = defineError(
  'SF-SCHED-002',
  'aborted',
  'The worker scheduler was disposed; the task was dropped.',
  'Expected when the worker shuts down (dispose it in onShutdown). Do not post tasks after dispose; long jobs check the abort signal they are given.',
);
