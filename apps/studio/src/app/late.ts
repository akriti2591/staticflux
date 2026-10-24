/**
 * Late units: registered after the first navigation, off the boot path (R12.12
 * "everything lazy by default"). This module is a separate chunk imported by the
 * post-boot subsystem; until it lands, nothing depends on these tokens.
 *
 * - AI: mock provider + browser built-in AI (feature-detected) behind the model router.
 * - WebMCP: agent-exposed capabilities published as tools (no-op where unsupported).
 * - Warmup: likely-tier warmup ranked by the statistical next-chunk advisor, and a
 *   speculation rule for the billing chunk (hover on an upgrade CTA).
 */
import type { Registration } from '@staticflux/core';
import { advisorServiceUnit, browserAdvisorEnvironmentUnit } from '@staticflux/advisors';
import { browserAiProviderUnit, mockModelProviderUnit, modelRouterUnit } from '@staticflux/ai';
import { defineSpeculationRule, speculationEngineUnit, speculationRuleUnit, warmupUnit } from '@staticflux/loader';
import { modelContextAdapterUnit, webMcpPublisherUnit } from '@staticflux/webmcp';
import { advisorStorageUnit, advisorWarmupRankerUnit, chunkCursorUnit, nextChunkAdvisorUnits } from '../adapters/advisors-loader.js';
import { navigationWarmupSubsystemUnit, NavigationWarmupToken } from '../adapters/loader-router.js';
import { Chunks } from './contracts.js';

export { NavigationWarmupToken };
export { ModelProviderToken } from '@staticflux/ai';
export { WebMcpPublisherToken } from '@staticflux/webmcp';

export const lateUnits: readonly Registration[] = [
  // AI (never on the critical path; every call has a non-AI fallback).
  mockModelProviderUnit({ summarize: (text) => `Summary: ${text.split(/\s+/).slice(0, 12).join(' ')}…`, generate: (prompt) => `Draft: ${prompt}` }),
  browserAiProviderUnit,
  modelRouterUnit,
  // WebMCP.
  modelContextAdapterUnit,
  webMcpPublisherUnit,
  // Warmup + advisors + speculation.
  warmupUnit,
  speculationEngineUnit,
  speculationRuleUnit(defineSpeculationRule({ id: 'studio/upgrade-cta', chunks: [Chunks.billing], eagerness: 'moderate', action: 'load', dwellMs: 150 })),
  chunkCursorUnit,
  advisorStorageUnit,
  browserAdvisorEnvironmentUnit,
  advisorServiceUnit,
  ...nextChunkAdvisorUnits,
  advisorWarmupRankerUnit,
  navigationWarmupSubsystemUnit,
];
