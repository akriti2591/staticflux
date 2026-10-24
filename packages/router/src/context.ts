/**
 * The navigation context every stage step receives. It is a plain value plus typed
 * slots (core tokens as keys) so plugins share data (gate decisions, loaded chunks, …)
 * without magic strings.
 */
import type { Span, Token } from '@staticflux/core';
import type { FeatureId } from '@staticflux/runtime';
import type { AnyDialog } from './dialogs.js';
import type { AnyRoute, CapabilityId, RouteMatch, RouteRequirements } from './routes.js';
import type { PipelineKind, StageName } from './stages.js';

/** What started a navigation. */
export type NavigationTrigger = 'initial' | 'push' | 'replace' | 'traverse' | 'redirect' | 'refresh' | 'external';

/**
 * Serializable description of a navigation (Ember "transition" idea): store it across a
 * login redirect (handoff) and `router.retry(intent)` it later.
 */
export interface NavigationIntent {
  readonly href: string;
  readonly mode: 'push' | 'replace';
  readonly state?: unknown;
}

/** The feature the availability stage selected for one route segment (R18.5). */
export interface SelectedFeature {
  readonly route: AnyRoute;
  readonly capability: CapabilityId;
  readonly feature: FeatureId;
  readonly leave: 'unmount' | 'hide';
}

export interface NavigationContext {
  readonly id: number;
  readonly kind: PipelineKind;
  readonly trigger: NavigationTrigger;
  readonly intent: NavigationIntent;
  /** Committed match before this navigation (undefined for the first navigation). */
  readonly from: RouteMatch | undefined;
  readonly to: RouteMatch;
  /** Route segments being entered (outermost first) and left (innermost first). */
  readonly entering: readonly AnyRoute[];
  readonly leaving: readonly AnyRoute[];
  readonly dialog: { readonly from: AnyDialog | undefined; readonly to: AnyDialog | undefined };
  /** Merged `requires` of the target chain (inner overrides outer), plus the entering dialog's. */
  readonly requires: RouteRequirements;
  /** Filled by the availability stage. */
  readonly features: readonly SelectedFeature[];
  /** Current stage (updated as the pipeline advances). */
  readonly stage: StageName;
  /** Aborted when a newer navigation supersedes this one (or the router is disposed). */
  readonly signal: AbortSignal;
  /** The `nav.pipeline` span (parent for plugin spans). */
  readonly span: Span;
  /** Hrefs this navigation was redirected from (oldest first). */
  readonly redirects: readonly string[];
  /** True when the navigation was started by history (back/forward, link interception, host). */
  readonly external: boolean;
  /** Typed scratch slots shared between steps of this navigation. */
  get<T>(slot: Token<T>): T | undefined;
  set<T>(slot: Token<T>, value: T): void;
}
