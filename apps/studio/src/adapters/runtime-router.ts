/**
 * Adapter: @staticflux/runtime feature host → @staticflux/router feature driver.
 * The `load` stage activates the selected feature (after auth/authorize, R7.8),
 * `render` mounts it into the app's main outlet; leaving a route unmounts (logic warm).
 */
import { unit } from '@staticflux/core';
import { featureHostDriver, RouteFeatureDriverToken } from '@staticflux/router';
import { FeatureHostToken } from '@staticflux/runtime';
import { OutletsToken } from '../app/contracts.js';

export const outletFeatureDriverUnit = unit({
  id: 'studio/outlet-feature-driver-unit',
  provides: RouteFeatureDriverToken,
  scope: 'app',
  deps: { required: { host: FeatureHostToken, outlets: OutletsToken } },
  create: ({ host, outlets }) => featureHostDriver(host, { targetFor: () => outlets.main }),
  description: 'Route features mount into the main outlet.',
});
