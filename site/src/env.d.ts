/// <reference types="vite/client" />

/** Types of the StaticFlux Vite plugin's virtual module (see tooling/vite-plugin/AGENTS.md). */
declare module 'virtual:sf-chunks' {
  export const chunks: Readonly<Record<string, () => Promise<unknown>>>;
  export const chunkIds: readonly string[];
  export function importChunk(id: string): Promise<unknown>;
}
