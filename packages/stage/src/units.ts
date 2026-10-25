/**
 * DI tokens and units for @staticflux/stage. A stage and an undo service belong to one open document, so editors
 * provide them in the document's scope (feature or session); the attribution port is app-wide.
 *
 *   unit({ id: 'editor/undo', provides: UndoServiceToken, scope: 'feature',
 *          deps: { required: { doc: OpenDocumentToken, stage: StageToken } },
 *          create: ({ doc, stage }, ctx) => {
 *            const undo = createUndoService({ doc, guard: (changes, actor) => checkAll(stage, changes, actor) });
 *            ctx.scope.defer(() => undo.dispose());
 *            return undo;
 *          } })
 */
import { type ScopeLevel, token, type TokenId, unit, type UnitDefinition } from '@staticflux/core';
import { type AttributionPort, type AttributionPortOptions, AttributionPortToken, createAttributionPort } from './attribution.js';
import type { Stage } from './stage.js';
import type { UndoService } from './undo.js';

export const StageToken = /* @__PURE__ */ token('stage/stage').type<Stage>();
export const UndoServiceToken = /* @__PURE__ */ token('stage/undo-service').type<UndoService>();

/** A unit providing the attribution port (default scope `app`). */
export function attributionPortUnit(options: {
  readonly id: TokenId;
  readonly scope?: ScopeLevel;
  readonly port: AttributionPortOptions;
}): UnitDefinition<AttributionPort, Record<never, never>, 'stage/attribution-port'> {
  return unit<AttributionPort, Record<never, never>, 'stage/attribution-port'>({
    id: options.id,
    provides: AttributionPortToken,
    scope: options.scope ?? 'app',
    create: () => createAttributionPort(options.port),
  });
}
