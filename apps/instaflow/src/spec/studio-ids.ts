/**
 * Stable ids of Studio's contributions (data only, no Lit: the editor worker imports them, B9). Specs, saved specs and
 * pins refer to them; `studio-contributions.ts` re-exports them.
 */
export const StudioIds = Object.freeze({
  lens: { canvas: 'instaflow/lens-canvas', pixel: 'instaflow/lens-pixel', timeline: 'instaflow/lens-timeline', flow: 'instaflow/lens-flow', pages: 'instaflow/lens-pages' },
  tool: {
    select: 'instaflow/select',
    frame: 'instaflow/frame',
    shape: 'instaflow/shape',
    text: 'instaflow/text',
    pen: 'instaflow/pen',
    hand: 'instaflow/hand',
    brush: 'instaflow/brush',
    heal: 'instaflow/heal',
    crop: 'instaflow/crop',
    split: 'instaflow/split',
    connect: 'instaflow/connect',
  },
  panel: {
    chat: 'instaflow/chat',
    layers: 'instaflow/layers',
    pages: 'instaflow/pages',
    assets: 'instaflow/assets',
    brand: 'instaflow/brand',
    properties: 'instaflow/properties',
    adjust: 'instaflow/adjust',
    typography: 'instaflow/typography',
    // B8: the M1b panels Studio places (their contributions live with their features).
    milestones: 'instaflow/milestones',
    appearance: 'instaflow/appearance',
    repeat: 'instaflow/repeat',
    // B10a: the numeric transform bar.
    transform: 'instaflow/transform',
    // C1: PNG, PDF and SVG export.
    export: 'instaflow/export',
  },
  hud: {
    rewrite: 'instaflow/rewrite',
    animate: 'instaflow/animate',
    removeBackground: 'instaflow/remove-background',
    more: 'instaflow/more',
    ask: 'instaflow/ask',
  },
} as const);
