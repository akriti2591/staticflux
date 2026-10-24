/**
 * Feature `studio/mobile` (chunk `feature:studio-mobile`): the compact editor. Same
 * shared logic and document store as studio-desktop; a different UI (R18.5).
 */
import { ok } from '@staticflux/core';
import { defineFeatureModule } from '@staticflux/runtime';
import { html } from 'lit';
import type { DocumentStore } from '../../app/contracts.js';
import { activateStudioLogic, guardPendingSave, snapshotStudio } from '../../lib/studio-logic.js';
import { mountFeatureRoot } from '../../ui/feature-root.js';
import { defineMobileEditor } from './editor.js';

let store: DocumentStore | undefined;

export default defineFeatureModule({
  async activate(context) {
    const logic = await activateStudioLogic(context);
    if (!logic.ok) return logic;
    store = logic.value;
    return ok();
  },
  async mount(context) {
    defineMobileEditor();
    const guarded = await guardPendingSave(context);
    if (!guarded.ok) return guarded;
    await mountFeatureRoot(context, () => html`<studio-mobile-editor></studio-mobile-editor>`);
    return ok();
  },
  snapshot: () => snapshotStudio(store),
  deactivate() {
    store = undefined;
  },
});
