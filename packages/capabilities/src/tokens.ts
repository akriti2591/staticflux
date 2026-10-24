/** DI tokens of @staticflux/capabilities (no implementation imports: the registry can load lazily). */
import { token } from '@staticflux/core';
import type {
  AnyCapability,
  AnyCapabilityImplementation,
  CapabilityConfirmPort,
  CapabilityDecidePort,
  CapabilityMeterPort,
  FeatureActivationPort,
} from './capability.js';
import type { CapabilityRegistry } from './registry.js';

export const CapabilityDeclarationsToken = /* @__PURE__ */ token('capabilities/declarations').multi<AnyCapability>();
export const CapabilityImplementationsToken = /* @__PURE__ */ token('capabilities/implementations').multi<AnyCapabilityImplementation>();
export const CapabilityDecidePortToken = /* @__PURE__ */ token('capabilities/decide-port').type<CapabilityDecidePort>();
export const CapabilityConfirmPortToken = /* @__PURE__ */ token('capabilities/confirm-port').type<CapabilityConfirmPort>();
export const CapabilityMeterPortToken = /* @__PURE__ */ token('capabilities/meter-port').type<CapabilityMeterPort>();
export const FeatureActivationPortToken = /* @__PURE__ */ token('capabilities/activation-port').type<FeatureActivationPort>();
export const CapabilityRegistryToken = /* @__PURE__ */ token('capabilities/registry').type<CapabilityRegistry>();
