/**
 * Logic shared by the per-mode editor variants (studio-desktop, studio-mobile).
 * Not a feature: a small library both feature chunks bundle, so the features never
 * import each other (R20.3). Everything is bound to the feature's scopes.
 */
import { err, ok, type Result, type Scope, watch } from '@staticflux/core';
import { UserDataToken } from '@staticflux/data';
import { guard, isMatchOf, proceed, RouterToken } from '@staticflux/router';
import type { FeatureLogicContext, FeatureUiContext } from '@staticflux/runtime';
import { boxAdapter, UrlSyncToken } from '@staticflux/urlstate';
import { type DocumentStore, DocumentStoreToken, LastDocSlice, TabBinding } from '../app/contracts.js';
import { DocRoute } from '../app/routes.js';

/** Logic (activate): follow `/studio/doc/:id`, bind `?tab=` view state, remember the last doc. */
export async function activateStudioLogic(context: FeatureLogicContext): Promise<Result<DocumentStore>> {
  const [doc, router, sync, userData] = await Promise.all([
    context.injector.get(DocumentStoreToken, context.signal),
    context.injector.get(RouterToken, context.signal),
    context.injector.get(UrlSyncToken, context.signal),
    context.injector.get(UserDataToken, context.signal),
  ]);
  if (!doc.ok) return doc;
  if (!router.ok) return router;
  if (!sync.ok) return sync;
  const bound = sync.value.bind(TabBinding, boxAdapter(doc.value.tab), context.scope);
  if (!bound.ok) return err(bound.error);
  const lastDoc = userData.ok ? userData.value.slice(LastDocSlice) : undefined;
  const openFromRoute = (id: string | undefined): void => {
    if (id === undefined) return;
    void doc.value.open(id, context.signal).then((opened) => {
      if (opened.ok) lastDoc?.set({ id });
    });
  };
  watch(
    () => {
      const match = router.value.pending === undefined ? router.value.current : router.value.match(router.value.pending.href);
      return isMatchOf(match, DocRoute) ? match.params.id : undefined;
    },
    openFromRoute,
    { scope: context.scope, fireImmediately: true },
  );
  return ok(doc.value);
}

/** UI (mount): leaving the editor waits for the pending save (exit guard, R7.2). */
export async function guardPendingSave(context: FeatureUiContext, scope: Scope = context.uiScope): Promise<Result<void>> {
  const [doc, router] = await Promise.all([context.injector.get(DocumentStoreToken), context.injector.get(RouterToken)]);
  if (!doc.ok) return doc;
  if (!router.ok) return router;
  router.value.guardExit(
    DocRoute,
    guard(
      async (_navigation, signal) => {
        const flushed = await doc.value.flush(signal);
        return flushed.ok ? proceed() : err(flushed.error);
      },
      { uninterruptible: true, name: 'studio/save-before-leave' },
    ),
    scope,
  );
  return ok();
}

/** Archive payload of the editor (heavy features archive on demotion, R5.3). */
export interface StudioSnapshot {
  readonly docId: string | null;
  readonly tab: string | null;
}

export function snapshotStudio(doc: DocumentStore | undefined): StudioSnapshot {
  return doc === undefined ? { docId: null, tab: null } : { docId: doc.docId ?? null, tab: doc.tab.get() ?? null };
}

export function isStudioSnapshot(value: unknown): value is StudioSnapshot {
  return typeof value === 'object' && value !== null && 'docId' in value && 'tab' in value;
}
