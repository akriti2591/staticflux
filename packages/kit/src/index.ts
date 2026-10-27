/**
 * @staticflux/kit — themed Lit components on `@staticflux/ui`'s base element. Import a
 * component's own entry point (`@staticflux/kit/button`) to load only what you use; the
 * root re-exports everything and `defineKit()` registers every element.
 */
import { defineButton } from './button.js';
import { defineCard } from './card.js';
import { defineCapabilityPalette } from './command-palette.js';
import { defineColorField } from './color-field.js';
import { defineDock } from './dock.js';
import { defineIconButton } from './icon-button.js';
import { defineIconElement } from './icon.js';
import { defineInlineEdit } from './inline-edit.js';
import { defineNumberField } from './number-field.js';
import { defineSwatch } from './swatch.js';
import { defineInspector } from './inspector.js';
import { defineMenu } from './menu.js';
import { definePopover } from './popover.js';
import { defineSegmented } from './segmented.js';
import { defineSlider } from './slider.js';
import { defineSurfaces } from './surfaces.js';
import { defineTabs } from './tabs.js';
import { defineStatus } from './status.js';
import { defineTag } from './tag.js';
import { defineTextField } from './text-field.js';
import { defineToolbar } from './toolbar.js';
import { defineTooltip } from './tooltip.js';
import { defineTree } from './tree.js';
import { defineShortcutSheet } from './shortcut-sheet.js';
import { defineSizeField } from './size-field.js';
import { defineConfirmRow } from './confirm-row.js';
import { defineFeedback } from './feedback.js';
import { defineCopyField } from './copy-field.js';
import { defineHint } from './hint.js';
import { defineDisclosure } from './disclosure.js';
import { defineColorPopover } from './color-popover.js';
import { defineFontPicker } from './font-picker.js';
import { defineAlignPopover } from './align-popover.js';

export * from './messages.js';
export * from './feedback-messages.js';
export * from './picker-messages.js';
export * from './errors.js';
export * from './icon.js';
export * from './number-field.js';
export * from './inline-edit.js';
export * from './swatch.js';
export * from './roving.js';
export * from './position.js';
export * from './button.js';
export * from './icon-button.js';
export * from './segmented.js';
export * from './text-field.js';
export * from './slider.js';
export * from './tag.js';
export * from './status.js';
export * from './card.js';
export * from './color-field.js';
export * from './popover.js';
export * from './tooltip.js';
export * from './menu.js';
export * from './tabs.js';
export * from './surfaces.js';
export * from './toolbar.js';
export * from './dock.js';
export * from './inspector.js';
export * from './tree.js';
export * from './shortcut-sheet.js';
export * from './size-field.js';
export * from './command-palette.js';
export * from './overlay.js';
export * from './confirm-row.js';
export * from './feedback.js';
export * from './copy-field.js';
export * from './hint.js';
export * from './disclosure.js';
export * from './color-popover.js';
export * from './font-picker.js';
export * from './align-popover.js';
export { resizeMachine, sizeFromDrag, sizeFromKey, clampSize } from './internal/resize.js';

/** Register every kit element (idempotent). Prefer the per-component `define*` in boot paths. */
export function defineKit(registry: CustomElementRegistry = customElements): void {
  for (const define of [
    defineIconElement,
    defineButton,
    defineIconButton,
    defineNumberField,
    defineInlineEdit,
    defineSwatch,
    defineSegmented,
    defineTextField,
    defineSlider,
    defineTag,
    defineStatus,
    defineCard,
    defineColorField,
    definePopover,
    defineTooltip,
    defineMenu,
    defineTabs,
    defineSurfaces,
    defineToolbar,
    defineDock,
    defineInspector,
    defineTree,
    defineShortcutSheet,
    defineSizeField,
    defineCapabilityPalette,
    defineConfirmRow,
    defineFeedback,
    defineCopyField,
    defineHint,
    defineDisclosure,
    defineColorPopover,
    defineFontPicker,
    defineAlignPopover,
  ]) {
    define(registry);
  }
}
