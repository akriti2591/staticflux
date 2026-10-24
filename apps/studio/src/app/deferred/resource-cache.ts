/**
 * Deferred chunk: the session-scoped resource cache (SWR, dedup, optimistic updates). Each
 * session injector loads it on the first `ResourcesToken` resolution (home docs list, editor).
 */
import type { Registration } from '@staticflux/core';
import { resourcesUnit } from '@staticflux/data';

export const resourceCacheUnits: readonly Registration[] = [resourcesUnit];
