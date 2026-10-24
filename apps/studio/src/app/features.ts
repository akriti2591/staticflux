/**
 * Feature manifests (R5) and their chunks (R12.2). A manifest is data; the module
 * lives in its own chunk (`import()` → separate bundle). The loader adapter resolves
 * the chunk through the chunk loader (gated, deduped, retried); `load` below is the
 * plain fallback used when no loader is wired (unit tests of a single feature).
 */
import type { ChunkId } from '@staticflux/loader';
import { defineFeature, type FeatureId, type FeatureManifest, type FeatureModule } from '@staticflux/runtime';
import { Chunks, Features } from './contracts.js';

type ModuleImport = () => Promise<{ readonly default: FeatureModule }>;

/** The static chunk map (bundler-visible dynamic imports → one chunk per feature). */
export const chunkImports: Readonly<Record<ChunkId, ModuleImport>> = {
  [Chunks.studioDesktop]: () => import('../features/studio-desktop/index.js'),
  [Chunks.studioMobile]: () => import('../features/studio-mobile/index.js'),
  [Chunks.agentChat]: () => import('../features/agent-chat/index.js'),
  [Chunks.onboarding]: () => import('../features/onboarding/index.js'),
  [Chunks.settings]: () => import('../features/settings/index.js'),
  [Chunks.billing]: () => import('../features/billing/index.js'),
};

export { chunkDeclarations } from './chunks.js';

const fromChunk =
  (id: ChunkId) =>
  async (): Promise<FeatureModule> =>
    (await chunkImports[id]()).default;

/** feature id → logical chunk id (the loader adapter's lookup). */
export const featureChunks: Readonly<Record<FeatureId, ChunkId>> = {
  [Features.studioDesktop.id]: Chunks.studioDesktop,
  [Features.studioMobile.id]: Chunks.studioMobile,
  [Features.agentChat.id]: Chunks.agentChat,
  [Features.onboarding.id]: Chunks.onboarding,
  [Features.settings.id]: Chunks.settings,
  [Features.billing.id]: Chunks.billing,
};

export const featureManifests: readonly FeatureManifest[] = [
  defineFeature({
    id: Features.studioDesktop.id,
    weight: 'heavy',
    modes: ['expanded', 'medium'],
    retention: { priority: 'high', archive: true },
    readiness: { 'first-render': 'framework', interactive: 'feature', complete: 'feature' },
    budget: { chunkKb: 200 },
    load: fromChunk(Chunks.studioDesktop),
    description: 'Document editor for expanded/medium form factors.',
  }),
  defineFeature({
    id: Features.studioMobile.id,
    weight: 'heavy',
    modes: ['compact'],
    retention: { priority: 'normal', archive: true },
    load: fromChunk(Chunks.studioMobile),
    description: 'Document editor for compact form factors (same document store).',
  }),
  defineFeature({
    id: Features.agentChat.id,
    weight: 'warm',
    retention: { keepAliveMs: 5 * 60_000 },
    load: fromChunk(Chunks.agentChat),
    description: 'Agentic chat: headless logic + panel UI; tools are capabilities.',
  }),
  defineFeature({
    id: Features.onboarding.id,
    weight: 'cheap',
    load: fromChunk(Chunks.onboarding),
    description: 'Wizard with steps as view sub-routes and persisted progress.',
  }),
  defineFeature({
    id: Features.settings.id,
    weight: 'cheap',
    load: fromChunk(Chunks.settings),
    description: 'Theme/locale slices and workspace switch.',
  }),
  defineFeature({
    id: Features.billing.id,
    weight: 'cheap',
    load: fromChunk(Chunks.billing),
    description: 'Upgrade dialog (routable) and credit banner.',
  }),
];
