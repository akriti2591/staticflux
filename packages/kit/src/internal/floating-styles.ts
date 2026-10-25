import { css } from 'lit';
import { t } from './styles.js';

/** A floating surface (menus, popovers, tooltips): raised level, hairline border, minimal shadow. */
export const floatingStyles = css`
  .floating {
    box-sizing: border-box;
    margin: 0;
    inset: auto;
    position: fixed;
    background: ${t.color.surface2.css};
    color: ${t.color.text.css};
    border: 1px solid ${t.color.border.css};
    border-radius: ${t.radius.md.css};
    box-shadow: ${t.shadow.level1.css};
    padding: ${t.space.xs.css};
    opacity: 1;
    transform: none;
    transition:
      opacity ${t.motion.durationNormal.css} ${t.motion.easeEnter.css},
      transform ${t.motion.durationNormal.css} ${t.motion.easeEnter.css};
  }
  .floating:not([popover]) {
    z-index: ${t.z.overlay.css};
  }
  .floating:not([popover]):not([data-open]) {
    display: none;
  }
  .floating[popover]:not(:popover-open) {
    display: none;
  }
  @starting-style {
    .floating[data-open] {
      opacity: 0;
      transform: translateY(-2px);
    }
  }
  @media (forced-colors: active) {
    .floating {
      border-color: CanvasText;
    }
  }
`;
