/**
 * Logical chunk declarations of the site's islands (R12.2) — data only. Read by
 * vite.config.ts (the StaticFlux Vite plugin emits one named chunk per entry and lists it
 * in sf-manifest.json) and by the browser through `virtual:sf-chunks`.
 */
import { chunk, type ChunkDeclaration } from '@staticflux/loader';

export const islandChunks: readonly ChunkDeclaration[] = [
  chunk('island:theme', { entry: 'src/client/islands/theme.ts', tier: 'likely', budget: { category: 'sub-chunk' }, description: 'Theme switch (header, every page).' }),
  chunk('island:code', { entry: 'src/client/islands/code.ts', tier: 'speculative', budget: { category: 'sub-chunk' }, description: 'Copy-to-clipboard for code blocks.' }),
  chunk('island:packages', { entry: 'src/client/islands/packages.ts', tier: 'on-demand', budget: { category: 'sub-chunk' }, description: 'Layer filter + search on the packages page.' }),
  chunk('island:boot-trace', { entry: 'src/client/islands/boot-trace.ts', tier: 'on-demand', budget: { category: 'sub-chunk' }, description: 'Live boot waterfall of this page (footer).' }),
];
