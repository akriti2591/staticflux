/**
 * Logical chunk declarations (R12.2): data only (imported by the app *and* by
 * vite.config.ts for the StaticFlux Vite plugin, which names the bundler chunks after
 * these ids, emits sf-manifest.json / precache / build report and checks budgets).
 */
import { chunk, type ChunkDeclaration } from '@staticflux/loader';

export const chunkDeclarations: readonly ChunkDeclaration[] = [
  chunk('feature:studio-desktop', { entry: 'src/features/studio-desktop/index.ts', tier: 'on-demand', budget: { category: 'heavy', reason: 'Editor + rich surface; loaded only after authorize' } }),
  chunk('feature:studio-mobile', { entry: 'src/features/studio-mobile/index.ts', tier: 'on-demand', budget: { category: 'heavy', reason: 'Compact editor' } }),
  chunk('feature:agent-chat', { entry: 'src/features/agent-chat/index.ts', tier: 'likely', budget: { category: 'feature' } }),
  chunk('feature:onboarding', { entry: 'src/features/onboarding/index.ts', tier: 'likely', budget: { category: 'feature' } }),
  chunk('feature:settings', { entry: 'src/features/settings/index.ts', tier: 'on-demand', budget: { category: 'feature' } }),
  chunk('feature:billing', { entry: 'src/features/billing/index.ts', tier: 'speculative', budget: { category: 'feature' } }),
];
