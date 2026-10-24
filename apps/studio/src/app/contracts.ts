/**
 * Studio contracts: every typed value the app and its features share.
 *
 * Features never import each other (R20.3). They talk through what is declared here:
 * tokens of app-provided services, capability declarations, intents, URL bindings,
 * surfaces, slices, flags, meters and chunk ids. Implementations live elsewhere
 * (app composition, adapters, feature chunks); this file is declarations only.
 */
import { type Box, type Result, token } from '@staticflux/core';
import { s as cs, defineCapability } from '@staticflux/capabilities';
import { defineFlag, flagType } from '@staticflux/config';
import { s as ds, defineSlice } from '@staticflux/data';
import { defineMeter } from '@staticflux/gate';
import { defineHandoff } from '@staticflux/handoff';
import { defineCoachTarget } from '@staticflux/messaging';
import { featureRef } from '@staticflux/runtime';
import { codec, defineIntent, defineUrlBinding } from '@staticflux/urlstate';
import type { PresenceView } from '@staticflux/document';
import type { DocumentRecord } from './endpoints.js';

// ------------------------------------------------------------------ registries (declaration merging)

declare module '@staticflux/core' {
  interface Registry {
    urlParams: {
      tab: 'content' | 'comments' | 'history';
      panel: 'chat';
      prompt: string;
      workspace: string;
      lang: string;
      'sf-debug': true;
    };
    chunks: {
      'feature:studio-desktop': true;
      'feature:studio-mobile': true;
      'feature:agent-chat': true;
      'feature:onboarding': true;
      'feature:settings': true;
      'feature:billing': true;
    };
  }
}

declare module '@staticflux/config' {
  interface FlagRegistry {
    'studio/ai-suggestions': boolean;
    'onboarding/variant': 'A' | 'B';
  }
}

declare module '@staticflux/router' {
  interface RouteRequirements {
    /** Read by the auth-boundary plugin (adapters/auth-router.ts). */
    auth?: 'required' | 'optional';
    /** Gate resource checked by the authorize plugin (adapters/gate-router.ts). */
    gate?: { readonly level: 'route' | 'feature'; readonly id: string };
  }
}

// ------------------------------------------------------------------ features (referenced by id only)

export const Features = {
  studioDesktop: featureRef('studio/desktop'),
  studioMobile: featureRef('studio/mobile'),
  agentChat: featureRef('agent/chat'),
  onboarding: featureRef('onboarding/wizard'),
  settings: featureRef('settings/panel'),
  billing: featureRef('billing/upsell'),
} as const;

export const Chunks = {
  studioDesktop: 'feature:studio-desktop',
  studioMobile: 'feature:studio-mobile',
  agentChat: 'feature:agent-chat',
  onboarding: 'feature:onboarding',
  settings: 'feature:settings',
  billing: 'feature:billing',
} as const;

// ------------------------------------------------------------------ flags

export const AiSuggestionsFlag = defineFlag({
  key: 'studio/ai-suggestions',
  type: flagType.boolean(),
  default: false,
  owner: 'studio',
  preAuthSafe: false,
  description: 'Shows the AI panel slot (also needs the `ai` entitlement).',
});

export const OnboardingVariantFlag = defineFlag({
  key: 'onboarding/variant',
  type: flagType.enum(['A', 'B']),
  default: 'A',
  owner: 'onboarding',
  preAuthSafe: true,
  description: 'Onboarding copy experiment; bound to OnboardingCopyToken variants.',
});

// ------------------------------------------------------------------ meters

export const CreditsMeter = defineMeter('billing/credits', { unit: 'credits', mode: 'balance', lowThreshold: 3, reservationTtlMs: 60_000 });

// ------------------------------------------------------------------ URL state

export const TabBinding = defineUrlBinding({
  key: 'tab',
  kind: 'view',
  codec: codec.enum(['content', 'comments', 'history']),
  owner: 'studio/document-store',
  default: 'content',
});
export const WorkspaceBinding = defineUrlBinding({ key: 'workspace', kind: 'sticky', codec: codec.string({ maxLength: 40 }), owner: 'shell/workspaces' });
export const LangBinding = defineUrlBinding({ key: 'lang', kind: 'sticky', codec: codec.string({ maxLength: 12 }), owner: 'i18n/locale' });
export const DebugBinding = defineUrlBinding({ key: 'sf-debug', kind: 'sticky', codec: codec.flag(), owner: 'app/devtools' });

/** `?panel=chat&prompt=…` — consumed by agent-chat after authorize; prefill only (I-13). */
export const ChatPromptIntent = defineIntent({
  id: 'agent/chat-prompt',
  owner: 'agent/chat',
  params: { panel: codec.enum(['chat']), prompt: codec.string({ maxLength: 2000 }) },
  required: ['panel'],
});

// ------------------------------------------------------------------ handoff slots

export interface GuestDraft {
  readonly title: string;
}
export const GuestDraftSlot = defineHandoff<GuestDraft>({
  key: 'studio/guest-draft',
  version: 1,
  lifetime: { ttlMs: 30 * 60_000 },
  scope: 'tab',
  schema: (v: unknown): v is GuestDraft => typeof v === 'object' && v !== null && typeof (v as { title?: unknown }).title === 'string',
});

// ------------------------------------------------------------------ user-data slices

export const ThemeSlice = defineSlice({
  key: 'settings/theme',
  scope: 'user',
  version: 1,
  schema: ds.object({ mode: ds.enum(['system', 'light', 'dark', 'high-contrast']) }),
  default: () => ({ mode: 'system' as const }),
});
export const LocaleSlice = defineSlice({
  key: 'settings/locale',
  scope: 'user',
  version: 1,
  schema: ds.object({ locale: ds.string() }),
  default: () => ({ locale: 'en' }),
});
export const OnboardingProgressSlice = defineSlice({
  key: 'onboarding/progress',
  scope: 'user',
  version: 1,
  schema: ds.object({ step: ds.number(), done: ds.boolean() }),
  default: () => ({ step: 1, done: false }),
});
export const LastDocSlice = defineSlice({
  key: 'studio/last-doc',
  scope: 'device',
  version: 1,
  schema: ds.object({ id: ds.nullable(ds.string()) }),
  default: () => ({ id: null as string | null }),
});

// ------------------------------------------------------------------ capabilities

export const InsertTextCapability = defineCapability({
  id: 'studio/insert-text',
  title: 'Insert paragraph',
  description: 'Append a text paragraph to the open document.',
  input: cs.object({ text: cs.string({ minLength: 1, maxLength: 4000 }) }),
  output: cs.object({ blockId: cs.string() }),
  policy: { resource: 'studio/insert-text' },
  requiresConfirmation: false,
  destructive: false,
});

export const InsertImageCapability = defineCapability({
  id: 'agent/insert-image',
  title: 'Insert image',
  description: 'Insert an image block into the open document.',
  input: cs.object({ src: cs.string({ minLength: 1 }), alt: cs.optional(cs.string()) }),
  output: cs.object({ blockId: cs.string() }),
  policy: { resource: 'agent/insert-image' },
  requiresConfirmation: false,
  destructive: false,
  costEstimate: () => ({ meter: CreditsMeter.id, amount: 2 }),
});

export const SummarizeCapability = defineCapability({
  id: 'studio/summarize',
  title: 'Summarize document',
  description: 'Summarize the open document with the on-device or mock model (Pro).',
  input: cs.object({}),
  output: cs.object({ summary: cs.string() }),
  policy: { resource: 'studio/summarize' },
  feature: Features.studioDesktop,
  requiresConfirmation: false,
  destructive: false,
});

export const ClearDocumentCapability = defineCapability({
  id: 'studio/clear-document',
  title: 'Clear document',
  description: 'Remove every block of the open document.',
  input: cs.object({}),
  output: cs.object({ removed: cs.number() }),
  policy: { resource: 'studio/clear-document' },
  requiresConfirmation: false,
  destructive: true,
});

// ------------------------------------------------------------------ coach targets

export const AiButtonTarget = defineCoachTarget('studio/ai-button');

// ------------------------------------------------------------------ app-provided services

export interface BlockView {
  readonly id: string;
  readonly kind: 'text' | 'image';
  readonly order: string;
  readonly text: string;
  readonly src: string;
}

/**
 * Main-thread document store: a read-only projection of the document worker's engine.
 * Writes are intents to the worker (I-9). Shared by studio-desktop and studio-mobile.
 */
export interface DocumentStore {
  /** Reactive. */
  readonly docId: string | undefined;
  readonly title: string;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly blocks: readonly BlockView[];
  readonly pendingSave: boolean;
  /** Worker unavailable: read-only fallback (R4.4). */
  readonly readOnly: boolean;
  /** View state bound to `?tab=` (urlstate). */
  readonly tab: Box<'content' | 'comments' | 'history' | undefined>;
  open(id: string, signal?: AbortSignal): Promise<Result<void>>;
  insertText(text: string): Promise<Result<string>>;
  insertImage(src: string, alt?: string): Promise<Result<string>>;
  editText(blockId: string, text: string): Promise<Result<void>>;
  clear(): Promise<Result<number>>;
  rename(title: string): void;
  /** Wait for the pending save (exit guard). */
  flush(signal?: AbortSignal): Promise<Result<void>>;
  plainText(): string;
}
export const DocumentStoreToken = token('studio/document-store').type<DocumentStore>();

/** Presence of co-editors (lazy dependency of the editor). */
export interface PresenceFeed {
  /** Reactive. */
  readonly view: PresenceView;
  setLocal(name: string, cursor: { readonly entity: string; readonly index: number } | null): Promise<Result<void>>;
}
export const PresenceToken = token('studio/presence').type<PresenceFeed>();

/** DOM outlets the app owns; the router's feature driver mounts features into them. */
export interface StudioOutlets {
  readonly main: HTMLElement;
  readonly panel: HTMLElement;
  readonly inspector: HTMLElement;
}
export const OutletsToken = token('studio/outlets').type<StudioOutlets>();

/** Onboarding copy — variant-bound to OnboardingVariantFlag (feature code never reads the flag, R8.4). */
export interface OnboardingCopy {
  readonly variant: 'A' | 'B';
  readonly headline: string;
}
export const OnboardingCopyToken = token('onboarding/copy').type<OnboardingCopy>();

/** Opens the chat panel (implemented by the app; agent-chat is mounted into the panel outlet). */
export interface PanelController {
  /** Reactive. */
  readonly open: string | undefined;
  show(feature: 'agent/chat'): Promise<Result<void>>;
  hide(): Promise<Result<void>>;
}
export const PanelControllerToken = token('studio/panel').type<PanelController>();

export type { DocumentRecord };
