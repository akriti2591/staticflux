/**
 * Deferred chunk: the capability pipeline (registry, gate/confirm/meter/activation ports,
 * app-lifetime implementations, the upsell invoker). Loaded by `deferred.ts` on the first
 * resolution of `CapabilityRegistryToken` / `CapabilityInvokerToken` — i.e. when an editor
 * or the assistant activates, never on the boot path.
 */
import type { Registration } from '@staticflux/core';
import { capabilityRegistryUnit } from '@staticflux/capabilities';
import { gateCapabilityDecideUnit, gateCapabilityMeterUnit } from '../../adapters/capabilities-gate.js';
import { confirmPortUnit } from '../../adapters/capabilities-messaging.js';
import { upsellInvokerUnit } from '../../adapters/capabilities-router.js';
import { featureActivationPortUnit } from '../../adapters/capabilities-runtime.js';
import { clearDocumentImplementationUnit, documentCapabilityDeclarations, insertImageImplementationUnit, insertTextImplementationUnit } from '../capabilities.js';

export const capabilityUnits: readonly Registration[] = [
  gateCapabilityDecideUnit,
  confirmPortUnit,
  gateCapabilityMeterUnit,
  featureActivationPortUnit,
  capabilityRegistryUnit,
  ...documentCapabilityDeclarations,
  insertTextImplementationUnit,
  insertImageImplementationUnit,
  clearDocumentImplementationUnit,
  upsellInvokerUnit,
];
