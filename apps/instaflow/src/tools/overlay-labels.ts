/**
 * The overlay's distance labels as kit tags (`<sf-tag mono>`), positioned in screen space over the canvas (main thread:
 * the editor worker posts the labels and the camera, B9; the shell renders this layer).
 */
import { html, type TemplateResult } from 'lit';
import type { GuideLabel } from './snapping.js';
import type { Camera } from './view-state.js';

/** Distance labels as kit tags positioned in screen space (the shell places this layer over the canvas). */
export function guideLabelTemplate(labels: readonly GuideLabel[], camera: Camera): TemplateResult {
  return html`${labels.map((l) => {
    const x = l.x * camera.zoom + camera.tx;
    const y = l.y * camera.zoom + camera.ty;
    return html`<sf-tag mono data-guide-label style=${`position:absolute;left:0;top:0;transform:translate(${x}px, ${y}px) translate(-50%, -50%)`}>${l.text}</sf-tag>`;
  })}`;
}
