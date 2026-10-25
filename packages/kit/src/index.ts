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

export * from './messages.js';
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
export * from './command-palette.js';
export { resizeMachine, sizeFromDrag, sizeFromKey, clampSize } from './internal/resize.js';

/** Register every kit element (idempotent). Prefer the per-component `define*` in boot paths. */
export function defineKit(registry: CustomElementRegistry = customElements): void {
  for (const define of [
    defineButton,
    defineIconButton,
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
    defineCapabilityPalette,
  ]) {
    define(registry);
  }
}
