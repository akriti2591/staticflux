/**
 * Shared component styles. Every value is a theme-contract token (`themeTokens`), so a
 * theme (and its density / contrast / reduced-motion variants) restyles the whole kit.
 * Logical properties only (RTL); motion on compositor properties only; forced-colors
 * fall back to system colors.
 */
import { themeTokens as t } from '@staticflux/ui/theme';
import { css } from 'lit';

export { t };

/** Base for every kit element: font, box sizing, focus ring, forced colors. */
export const baseStyles = css`
  :host {
    box-sizing: border-box;
    font-family: ${t.font.family.css};
    font-size: ${t.type.sizeMd.css};
    line-height: ${t.type.lineTight.css};
    color: ${t.color.text.css};
  }
  :host([hidden]) {
    display: none !important;
  }
`;

/** Visually hidden, still announced (labels of `label-hidden` fields). */
export const srOnly = css`
  .sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
`;

/** Visible keyboard focus (SC 2.4.7/2.4.13) on the host or an inner element. */
export const focusRing = css`
  :host(:focus),
  .focus-target:focus {
    outline: none;
  }
  :host(:focus-visible),
  .focus-target:focus-visible {
    outline: 2px solid ${t.color.focusRing.css};
    outline-offset: 2px;
  }
  @media (forced-colors: active) {
    :host(:focus-visible),
    .focus-target:focus-visible {
      outline-color: Highlight;
    }
  }
`;

/** Control sizing (density-aware through `size.*`) and quiet transitions. */
export const controlStyles = css`
  :host {
    --kit-height: ${t.size.control.css};
    --kit-pad-inline: ${t.space.md.css};
  }
  :host([size='sm']) {
    --kit-height: ${t.size.controlSm.css};
    --kit-pad-inline: ${t.space.sm.css};
  }
  :host([size='lg']) {
    --kit-height: ${t.size.controlLg.css};
    --kit-pad-inline: ${t.space.lg.css};
  }
  .control {
    box-sizing: border-box;
    min-block-size: var(--kit-height);
    border-radius: ${t.radius.md.css};
    transition:
      background-color ${t.motion.durationFast.css} ${t.motion.easeStandard.css},
      border-color ${t.motion.durationFast.css} ${t.motion.easeStandard.css},
      color ${t.motion.durationFast.css} ${t.motion.easeStandard.css};
  }
`;
