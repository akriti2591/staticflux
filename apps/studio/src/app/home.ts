/**
 * The home view's data: the paginated document list (`docs.list`, SWR) from the
 * session-scoped resource cache. A new principal gets a new session scope (and a
 * fresh cache); an epoch bump refetches the observed list (R4.3, R9.3).
 */
import { box, ok, type Result, token, unit, watch } from '@staticflux/core';
import { SessionToken } from '@staticflux/auth';
import { type PaginatedHandle, ResourcesToken } from '@staticflux/data';
import { HandoffStoreToken } from '@staticflux/handoff';
import { SessionScopeToken } from '../adapters/auth-runtime.js';
import { GuestDraftSlot } from './contracts.js';
import { type DocSummary, type DocsPage, DocsListResource } from './endpoints.js';

export interface HomeDocs {
  /** Reactive: the observed list while signed in. */
  readonly list: PaginatedHandle<DocsPage, DocSummary> | undefined;
  /** A guest draft carried through login (consume-once). */
  takeGuestDraft(): Promise<Result<string | undefined>>;
}
export const HomeDocsToken = token('studio/home-docs').type<HomeDocs>();

export const homeDocsUnit = unit({
  id: 'studio/home-docs-unit',
  provides: HomeDocsToken,
  scope: 'app',
  deps: { required: { scopes: SessionScopeToken, session: SessionToken, handoff: HandoffStoreToken } },
  create: ({ scopes, session, handoff }, ctx): HomeDocs => {
    const list = box<PaginatedHandle<DocsPage, DocSummary> | undefined>(undefined);
    watch(
      () => [scopes.injector, session.isAuthenticated] as const,
      ([injector, authenticated]) => {
        list.set(undefined);
        if (injector === undefined || !authenticated) return;
        void injector.get(ResourcesToken, injector.scope.signal).then((resources) => {
          if (!resources.ok || scopes.injector !== injector) return;
          list.set(resources.value.paginated(DocsListResource, null, { scope: injector.scope }));
        });
      },
      { scope: ctx.scope, fireImmediately: true },
    );
    return {
      get list() {
        return list.get();
      },
      async takeGuestDraft() {
        const draft = await handoff.take(GuestDraftSlot);
        return draft.ok ? ok(draft.value?.title) : draft;
      },
    };
  },
  description: 'Observed docs.list for the home view (session-scoped cache).',
});
