/**
 * The surfaces' boot plans as loader data (Δ26; D17; C0 IF-28.25): which logical chunks each surface needs at boot.
 * Home's plan is the light boot — its own chunk and the kit — and names no engine chunk; Studio's plan makes the
 * engine eager, each with its reason (R12.12). The dev server serves pages directly; the production build maps these
 * ids to its output with `@staticflux/loader`'s `createManifest` (C4), so code for the other surface is never fetched.
 */
import { type BootPlan, chunk, type ChunkDeclaration, type ChunkIdShape, defineBootPlan, planChunks } from '@staticflux/loader';

/** Logical chunks of Instaflow's surfaces (entry = the module the build maps to the id). */
export const INSTAFLOW_CHUNKS = {
  home: /* @__PURE__ */ chunk('surface:home', { tier: 'critical', entry: 'src/home/index.ts', deps: ['lib:kit'], description: 'Home: model, element, workspace index read (no engine)' }),
  kit: /* @__PURE__ */ chunk('lib:kit', { tier: 'critical', description: '@staticflux/kit components under Clean Pop' }),
  studio: /* @__PURE__ */ chunk('surface:studio', { tier: 'likely', entry: 'src/app/studio-app.ts', deps: ['lib:kit', 'engine:document'], description: 'Studio chrome, panels and the canvas port' }),
  document: /* @__PURE__ */ chunk('engine:document', { tier: 'likely', description: 'Loro CRDT engine, document repo, stage' }),
  editor: /* @__PURE__ */ chunk('engine:editor-worker', { tier: 'likely', entry: 'src/workers/studio.worker.ts', deps: ['engine:document'], description: 'Editor and render modules (worker)' }),
  render: /* @__PURE__ */ chunk('wasm:render', { tier: 'likely', budget: { category: 'wasm' }, description: 'Vello render Wasm (WebGPU)' }),
  authoring: /* @__PURE__ */ chunk('wasm:authoring', { tier: 'likely', budget: { category: 'wasm' }, description: 'Geometry and text Wasm' }),
} as const satisfies Readonly<Record<string, ChunkDeclaration>>;

/** Home (`/`): the light boot. */
export const HOME_BOOT_PLAN = /* @__PURE__ */ defineBootPlan({
  id: 'instaflow/home',
  critical: ['surface:home', 'lib:kit'],
  description: 'Home: no document engine, no GPU, no worker (D17).',
});

/** Studio (`/s/:asset`, `/new`): the maximal spec. */
export const STUDIO_BOOT_PLAN = /* @__PURE__ */ defineBootPlan({
  id: 'instaflow/studio',
  critical: ['surface:studio', 'lib:kit'],
  eager: [
    { chunk: 'engine:document', reason: 'Studio opens a document before its first frame' },
    { chunk: 'engine:editor-worker', reason: 'The editor module runs in the worker from boot (D15)' },
    { chunk: 'wasm:render', reason: 'The canvas draws on first frame' },
    { chunk: 'wasm:authoring', reason: 'Geometry and text layout of the open page' },
  ],
});

/** Every chunk a plan touches at boot, with the dependencies of each (transitively). */
export function bootClosure(plan: BootPlan, chunks: Readonly<Record<string, ChunkDeclaration>> = INSTAFLOW_CHUNKS): readonly ChunkIdShape[] {
  const byId = new Map(Object.values(chunks).map((c) => [c.id as string, c]));
  const seen = new Set<ChunkIdShape>();
  const visit = (id: ChunkIdShape): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)?.deps ?? []) visit(dep);
  };
  for (const id of planChunks(plan)) visit(id);
  return [...seen];
}
