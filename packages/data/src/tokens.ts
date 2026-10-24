/** DI tokens of @staticflux/data (no implementation imports). */
import { token } from '@staticflux/core';
import type { DataClient } from './client.js';
import type { EpochSource } from './epoch.js';
import type { PauseControl } from './pause.js';
import type { Resources } from './resources.js';
import type { Transport } from './transport.js';
import type { UserData, UserDataOptions } from './user-data.js';

export const DataTransportToken = /* @__PURE__ */ token('data/transport').type<Transport>();
export const EpochSourceToken = /* @__PURE__ */ token('data/epoch-source').type<EpochSource>();
export const PauseControlToken = /* @__PURE__ */ token('data/pause-control').type<PauseControl>();
export const DataClientToken = /* @__PURE__ */ token('data/client').type<DataClient>();
export const ResourcesToken = /* @__PURE__ */ token('data/resources').type<Resources>();
export const UserDataConfigToken = /* @__PURE__ */ token('data/user-data-config').type<Omit<UserDataOptions, 'telemetry'>>();
export const UserDataToken = /* @__PURE__ */ token('data/user-data').type<UserData>();
