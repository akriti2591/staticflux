/**
 * The Instaflow mark (`apps/instaflow/brand/instaflow-mark.svg`, owner's choice 2026-10-25: the cursive "if" with the
 * colour-split dot) as inline SVG for the chrome (B11b, IF-36.27): Studio's top bar (26 px, STUDIO-UX-SPEC §10.2 point
 * 10) and Home's header lockup (28 px mark + wordmark). Decorative: the link around it carries the name ("Home").
 * Geometry is copied from the brand file and never edited here (brand README).
 */
import { html, type TemplateResult } from 'lit';

/** Brand colours (brand README: ink, tangerine split up-left, mint split down-right). */
export const MARK_COLORS = Object.freeze({ ink: '#16151A', tangerine: '#FF5C39', mint: '#00B37E' });

/** The mark at `size` px (aria-hidden). */
export function instaflowMark(size = 26): TemplateResult {
  const c = MARK_COLORS;
  return html`<svg width=${size} height=${size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" data-if-mark>
    <circle cx="15.1" cy="12.6" r="5" fill=${c.tangerine}></circle>
    <circle cx="18.9" cy="15.4" r="5" fill=${c.mint}></circle>
    <circle cx="17" cy="14" r="5" fill=${c.ink}></circle>
    <path d="M17 28V41C17 50 24.5 54 30.5 49.5C35 46 37 39.5 37 31V23C37 15 42.5 10.5 51.5 13" fill="none" stroke=${c.ink} stroke-width="6" stroke-linecap="round" stroke-linejoin="round"></path>
    <path d="M29.5 31H45" fill="none" stroke=${c.ink} stroke-width="5" stroke-linecap="round"></path>
  </svg>`;
}
