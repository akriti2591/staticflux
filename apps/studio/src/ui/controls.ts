/**
 * Kit controls the app-level views (header, home, login) use. Loaded as one chunk right
 * after boot (R12.12 lazy by default) instead of in the boot bundle; the elements upgrade in
 * place (Lit keeps `@event` bindings and properties set before the upgrade), and
 * `pendingControlStyles` keeps their size before they are defined (no layout shift).
 * Feature chunks import the same kit modules, so they share this chunk.
 */
import { defineButton } from '@staticflux/kit/button';
import { defineTextField } from '@staticflux/kit/text-field';

export function defineAppControls(): void {
  defineButton();
  defineTextField();
}
