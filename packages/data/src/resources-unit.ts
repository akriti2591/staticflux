/** The resource-cache unit (own module: apps may register it from a lazily loaded chunk). */
import { unit } from '@staticflux/core';
import { createResources } from './resources.js';
import { DataClientToken, ResourcesToken } from './tokens.js';

/** Resource cache. Session-scoped so logout drops cached user data with the session scope. */
export const resourcesUnit = unit({
  id: 'data/resources-unit',
  provides: ResourcesToken,
  scope: 'session',
  deps: { required: { client: DataClientToken } },
  create: ({ client }, ctx) => {
    const resources = createResources({ client });
    ctx.scope.defer(() => resources.dispose());
    return resources;
  },
  description: 'Keyed SWR cache, dedup, optimistic updates, epoch-aware refetch.',
});
