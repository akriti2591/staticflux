import { css } from 'lit';
import { t } from './styles.js';

/** Field chrome shared by text-like kit fields (text field, color field). */
export const fieldStyles = css`
  :host {
    display: inline-grid;
    gap: ${t.space.xs.css};
    min-inline-size: 0;
  }
  .label {
    font-size: ${t.type.sizeSm.css};
    font-weight: ${t.font.weightMedium.css};
    color: ${t.color.textMuted.css};
  }
  .field {
    display: flex;
    align-items: center;
    gap: ${t.space.xs.css};
    padding-inline: ${t.space.sm.css};
    border-radius: ${t.radius.md.css};
    background: ${t.color.surfaceSunken.css};
    border: 1px solid ${t.color.controlEdge.css};
  }
  .field:focus-within {
    outline: 2px solid ${t.color.focusRing.css};
    outline-offset: 2px;
  }
  :host([invalid]) .field {
    border-color: ${t.color.danger.css};
  }
  input,
  textarea {
    all: unset;
    flex: 1;
    min-inline-size: 0;
    font: inherit;
    color: ${t.color.text.css};
  }
  textarea {
    padding-block: ${t.space.xs.css};
    white-space: pre-wrap;
    line-height: ${t.type.lineNormal.css};
  }
  input::placeholder,
  textarea::placeholder {
    color: ${t.color.textSubtle.css};
  }
  :host([disabled]) .field {
    color: ${t.color.textDisabled.css};
    border-color: ${t.color.border.css};
    cursor: not-allowed;
  }
  .hint,
  .error {
    font-size: ${t.type.sizeSm.css};
    color: ${t.color.textMuted.css};
  }
  .error {
    color: ${t.color.dangerText.css};
  }
  @media (forced-colors: active) {
    .field {
      border-color: FieldText;
    }
  }
`;

