/**
 * Adapter: @staticflux/data → @staticflux/config. The mock remote flag layer loads
 * through the data client (single retry layer, spans, breakers) instead of a
 * hand-rolled fetch. Identity-bound: non-pre-auth-safe flags wait for login.
 */
import { contribution } from '@staticflux/core';
import { createRemoteLayer, FlagLayersToken } from '@staticflux/config';
import { DataClientToken } from '@staticflux/data';
import { RemoteFlagsEndpoint } from '../app/endpoints.js';

export const remoteFlagLayerUnit = contribution({
  id: 'studio/remote-flag-layer-unit',
  provides: FlagLayersToken,
  scope: 'app',
  deps: { required: { client: DataClientToken } },
  create: ({ client }) =>
    createRemoteLayer({
      id: 'studio/mock-remote-flags',
      layer: 'remote',
      identityBound: true,
      load: (context, signal) => client.call(RemoteFlagsEndpoint, { user: context.targetingKey }, { signal }),
      retry: { attempts: 1 },
    }),
  description: 'Remote flag layer backed by the mock /flags endpoint.',
});
