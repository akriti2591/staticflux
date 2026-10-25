/**
 * Studio's contributions until the M1b packages land their real ones: the four lenses of the mode
 * switcher, toolbar tools, the docked panels and HUD actions of `StudioCP.dc.html`. Panels render a
 * placeholder body; B1 (elements), B2 (text), B3 (tools), B4 (library, lenses) and B5 (versioning)
 * replace them by contributing the same ids (the coordinator reconciles at merge, M1B-NOTES).
 * Ids are stable: specs, saved specs and pins refer to them.
 */
import { html } from 'lit';
import { defineHudAction, defineLens, definePanel, defineTool, type PanelContext, type PanelContribution } from './contributions.js';

/** Stable ids of Studio's contributions. */
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
  },
  hud: {
    rewrite: 'instaflow/rewrite',
    animate: 'instaflow/animate',
    removeBackground: 'instaflow/remove-background',
    more: 'instaflow/more',
    ask: 'instaflow/ask',
  },
} as const);

const L = StudioIds.lens;

export const studioLenses = Object.freeze([
  defineLens({ id: L.canvas, label: 'Canvas', palette: 'layout', shortcut: '1', description: 'The infinite canvas: pages at their positions plus loose elements (D19).' }),
  defineLens({ id: L.pixel, label: 'Pixel', palette: 'pixel', shortcut: '2', scopes: ['asset', 'selection', 'layer'], description: 'Raster edits on an image layer.' }),
  defineLens({ id: L.timeline, label: 'Timeline', palette: 'video', shortcut: '3', description: 'The story in time: pages as clips, tracks.' }),
  defineLens({ id: L.flow, label: 'Flow', palette: 'flow', shortcut: '4', scopes: ['asset', 'selection'], description: 'Workflows: steps and edges.' }),
  // B4: the story — pages in order, one after another (a layout lens like Canvas; its feature is `src/lenses`).
  defineLens({ id: L.pages, label: 'Pages', palette: 'layout', shortcut: '5', scopes: ['asset', 'page', 'selection'], description: 'The story: pages in order (D19: a lens on top of the canvas).' }),
]);

const T = StudioIds.tool;

export const studioTools = Object.freeze([
  defineTool({ id: T.select, label: 'Select', glyph: '↖', shortcut: 'V' }),
  defineTool({ id: T.frame, label: 'Frame', glyph: '#', shortcut: 'F', lenses: [L.canvas] }),
  defineTool({ id: T.shape, label: 'Shape', glyph: '▢', shortcut: 'R', lenses: [L.canvas, L.pages] }),
  defineTool({ id: T.text, label: 'Text', glyph: 'T', shortcut: 'T', lenses: [L.canvas, L.pages] }),
  defineTool({ id: T.pen, label: 'Pen', glyph: '✒', shortcut: 'P', lenses: [L.canvas, L.pages] }),
  defineTool({ id: T.hand, label: 'Hand', glyph: '✋', shortcut: 'H' }),
  defineTool({ id: T.brush, label: 'Brush', glyph: '◍', shortcut: 'B', lenses: [L.pixel] }),
  defineTool({ id: T.heal, label: 'Heal', glyph: '✚', shortcut: 'J', lenses: [L.pixel] }),
  defineTool({ id: T.crop, label: 'Crop', glyph: '⌗', shortcut: 'C', lenses: [L.pixel, L.canvas] }),
  defineTool({ id: T.split, label: 'Split', glyph: '⫶', shortcut: 'S', lenses: [L.timeline] }),
  defineTool({ id: T.connect, label: 'Connect', glyph: '⤳', shortcut: 'E', lenses: [L.flow] }),
]);

/** Placeholder body until the owning work package contributes the real panel. */
const placeholder = (owner: string) => (context: PanelContext) => html`<p data-placeholder=${owner}>Arrives with ${owner} · ${context.density}</p>`;

const P = StudioIds.panel;

export const studioPanels: readonly PanelContribution[] = Object.freeze([
  definePanel({ id: P.chat, label: 'Chat', placements: ['side', 'dock'], minDensity: 'standard', render: placeholder('M2 (Chat)') }),
  definePanel({ id: P.layers, label: 'Layers', placements: ['dock', 'side'], minDensity: 'standard', render: placeholder('B1') }),
  definePanel({ id: P.pages, label: 'Pages', placements: ['dock', 'tray'], minDensity: 'standard', render: placeholder('B4') }),
  definePanel({ id: P.assets, label: 'Assets', placements: ['dock'], minDensity: 'standard', render: placeholder('B4') }),
  definePanel({ id: P.brand, label: 'Brand', placements: ['dock'], minDensity: 'standard', render: placeholder('B4') }),
  definePanel({ id: P.properties, label: 'Properties', placements: ['inspector'], minDensity: 'pro', render: placeholder('B1 / B2') }),
  definePanel({ id: P.adjust, label: 'Adjust', placements: ['inspector'], minDensity: 'focus', lenses: [L.pixel], render: placeholder('B3') }),
]);

const H = StudioIds.hud;

export const studioHudActions = Object.freeze([
  defineHudAction({ id: H.rewrite, label: 'Rewrite', tone: 'agent', lenses: [L.canvas, L.pages] }),
  defineHudAction({ id: H.animate, label: 'Animate', tone: 'direct', lenses: [L.canvas, L.timeline, L.pages] }),
  defineHudAction({ id: H.removeBackground, label: 'Remove background', tone: 'agent', lenses: [L.pixel, L.canvas] }),
  defineHudAction({ id: H.more, label: 'More actions', tone: 'more' }),
  defineHudAction({ id: H.ask, label: 'Ask', tone: 'agent' }),
]);
