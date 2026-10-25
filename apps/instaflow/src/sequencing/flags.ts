/**
 * Boot settings of the editor ↔ render pipeline as typed flags (contracts only; read them in
 * `sequencing.bindings.ts`, never in module code).
 */
import { defineFlag, flagType } from '@staticflux/config';

/** D15: both modules in one worker (default) or one worker each. */
export const SequencingTopologyFlag = /* @__PURE__ */ defineFlag({
  key: 'instaflow/sequencing-topology',
  type: flagType.enum(['colocated', 'split']),
  default: 'colocated',
  owner: 'instaflow-engine',
  preAuthSafe: true,
  description: 'D15 boot setting: editor and render modules share one worker (default) or use two.',
});

/** The main-rAF tick experiment: who paces the render module's ticks. */
export const RenderTickFlag = /* @__PURE__ */ defineFlag({
  key: 'instaflow/render-tick',
  type: flagType.enum(['worker-raf', 'main-raf']),
  default: 'worker-raf',
  owner: 'instaflow-engine',
  preAuthSafe: true,
  description: 'Render ticks from the render worker rAF (default) or from a main-thread rAF tick cell (Atomics.notify), with draw on arrival and no coalesce delay.',
});
