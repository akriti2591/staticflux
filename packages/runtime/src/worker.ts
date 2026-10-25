/**
 * Worker-side runtime (SF-Δ28): the priority scheduler with cooperative yielding
 * and the long-task detector for code running inside workers. Separate entry
 * point: main-thread bundles never pay for it.
 */
export * from './worker-scheduler.js';
export { WorkerSchedulerDisposedError } from './errors.js';
export { PRIORITIES, type Priority } from './scheduler.js';
