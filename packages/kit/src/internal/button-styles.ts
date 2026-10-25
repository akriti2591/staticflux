/** Styles and attribute converters shared by `<sf-button>` and `<sf-icon-button>`. */
import { css } from 'lit';
import { t } from './styles.js';

export type ControlSize = 'sm' | 'md' | 'lg';

/** `pressed` attribute: absent → not a toggle; `"false"` → false; anything else → true. */
export const pressedConverter = {
  fromAttribute: (value: string | null): boolean | undefined => (value === null ? undefined : value !== 'false'),
  toAttribute: (value: boolean | undefined): string | null => (value === undefined ? null : String(value)),
};

/** Styles shared by `<sf-button>` and `<sf-icon-button>`. */
export const buttonStyles = css`
  :host {
    display: inline-flex;
    vertical-align: middle;
    cursor: pointer;
    user-select: none;
    border-radius: ${t.radius.control.css};
  }
  .control {
    display: inline-flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    gap: ${t.space.xs.css};
    padding-inline: var(--kit-pad-inline);
    font-weight: ${t.font.weightMedium.css};
    white-space: nowrap;
    border: 1px solid ${t.color.controlEdge.css};
    background: ${t.color.surface1.css};
    color: ${t.color.text.css};
  }
  :host(:hover) .control {
    background: ${t.color.surfaceHover.css};
  }
  :host(:active) .control {
    background: ${t.color.surfaceActive.css};
  }
  :host([variant='primary']) .control {
    background: ${t.color.accent.css};
    border-color: transparent;
    color: ${t.color.textOnAccent.css};
  }
  :host([variant='primary']:hover) .control {
    background: ${t.color.accentHover.css};
  }
  :host([variant='primary']:active) .control {
    background: ${t.color.accentActive.css};
  }
  :host([variant='agent']) .control {
    background: ${t.color.agent.css};
    border-color: transparent;
    color: ${t.color.onAgent.css};
  }
  :host([variant='agent']:hover) .control,
  :host([variant='agent']:active) .control {
    background: ${t.color.agentHover.css};
  }
  :host([variant='agent-soft']) .control {
    background: ${t.color.agentSoft.css};
    border-color: transparent;
    color: ${t.color.agentInk.css};
  }
  :host([variant='agent-soft']:hover) .control {
    box-shadow: inset 0 0 0 1px ${t.color.agentInk.css};
  }
  :host([variant='danger']) .control {
    background: ${t.color.danger.css};
    border-color: transparent;
    color: ${t.color.textOnAccent.css};
  }
  :host([variant='ghost']) .control {
    background: transparent;
    border-color: transparent;
  }
  :host([variant='ghost']:hover) .control {
    background: ${t.color.surfaceHover.css};
  }
  :host([aria-pressed='true']) .control {
    background: ${t.color.accentSubtle.css};
    border-color: transparent;
    color: ${t.color.accentText.css};
  }
  :host([disabled]) {
    cursor: not-allowed;
  }
  :host([disabled]) .control,
  :host([disabled]:hover) .control {
    background: ${t.color.surfaceSunken.css};
    border-color: ${t.color.border.css};
    color: ${t.color.textDisabled.css};
  }
  ::slotted(svg),
  ::slotted([slot='start']),
  ::slotted([slot='end']) {
    flex: none;
    inline-size: ${t.size.icon.css};
    block-size: ${t.size.icon.css};
  }
  @media (forced-colors: active) {
    .control {
      border-color: ButtonText;
    }
    :host([aria-pressed='true']) .control {
      background: Highlight;
      color: HighlightText;
    }
    :host([disabled]) .control {
      color: GrayText;
      border-color: GrayText;
    }
  }
`;

