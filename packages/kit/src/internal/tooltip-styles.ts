/** Bubble styles shared by `<sf-tooltip>` and `<sf-icon-button>`. */
import { css } from 'lit';
import { t } from './styles.js';

export const tooltipStyles = css`
  .tooltip {
    pointer-events: none;
    max-inline-size: min(320px, calc(100vw - 16px));
    padding-block: ${t.space.xs.css};
    padding-inline: ${t.space.sm.css};
    font-size: ${t.type.sizeSm.css};
    font-weight: ${t.font.weightMedium.css};
    background: ${t.color.neutral12.css};
    color: ${t.color.neutral1.css};
    border-color: transparent;
    border-radius: ${t.radius.sm.css};
    box-shadow: ${t.shadow.level2.css};
    white-space: nowrap;
  }
  .tooltip:not([popover]) {
    z-index: ${t.z.tooltip.css};
  }
  .tooltip kbd {
    margin-inline-start: ${t.space.sm.css};
    font-family: ${t.font.familyMono.css};
    font-size: ${t.type.sizeXs.css};
    opacity: 0.75;
  }
`;
