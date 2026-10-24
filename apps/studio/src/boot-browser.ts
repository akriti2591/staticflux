/**
 * Browser boot: compose the app against mock services, boot it, mount the UI root.
 * Exposes `globalThis.__STUDIO__` (injector, telemetry records, violations, journeys)
 * for devtools and the e2e smoke test.
 */
import type { DetectedMode } from '@staticflux/platform';
import { bootStudio } from './app/compose.js';
import { createBrowserEnvironment } from './app/environment.js';
import { mountStudioUi } from './app/shell.js';
import { browserDocumentWorkerSpawner } from './worker/spawn-browser.js';

export async function startStudio(detected: DetectedMode): Promise<void> {
  const env = createBrowserEnvironment({ spawnWorker: browserDocumentWorkerSpawner(), detected });
  const booted = await bootStudio(env);
  const root = document.getElementById('app');
  if (!booted.ok || root === null) {
    document.body.dataset['sfBoot'] = 'failed';
    console.error('[studio] boot failed', booted.ok ? 'missing #app' : booted.error);
    return;
  }
  const studio = booted.value;
  const mounted = await mountStudioUi(root, studio.injector);
  if (!mounted.ok) console.error('[studio] UI mount failed', mounted.error);
  document.body.dataset['sfBoot'] = studio.app.supervisor.state;
  (globalThis as { __STUDIO__?: unknown }).__STUDIO__ = {
    injector: studio.injector,
    supervisor: studio.app.supervisor,
    records: studio.perf.memory.records,
    violations: studio.perf.violations,
    journeys: studio.perf.journeys,
  };
}
