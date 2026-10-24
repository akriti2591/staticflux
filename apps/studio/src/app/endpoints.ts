/**
 * Typed backend endpoints and resources (R9.1, R9.2). The mock transport
 * (mocks/data-routes.ts) answers every one of them; a real deployment binds a
 * fetch transport to the same declarations.
 */
import {
  cursorPagination,
  defineBatchedResource,
  defineEndpoint,
  definePaginatedResource,
  defineResource,
  defineStreamEndpoint,
  defineStreamResource,
  type Infer,
  s,
} from '@staticflux/data';

export const BlockSchema = s.object({
  kind: s.enum(['text', 'image']),
  text: s.optional(s.string()),
  src: s.optional(s.string()),
});
export const DocumentSchema = s.object({
  id: s.string(),
  title: s.string(),
  ownerId: s.string(),
  updatedAt: s.number(),
  blocks: s.array(BlockSchema),
});
export type DocumentRecord = Infer<typeof DocumentSchema>;
export type BlockRecord = Infer<typeof BlockSchema>;

export const DocSummarySchema = s.object({ id: s.string(), title: s.string(), updatedAt: s.number() });
export type DocSummary = Infer<typeof DocSummarySchema>;
export const DocsPageSchema = s.object({ items: s.array(DocSummarySchema), nextCursor: s.nullable(s.string()) });
export type DocsPage = Infer<typeof DocsPageSchema>;

export const ProfileSchema = s.object({ id: s.string(), name: s.string(), color: s.string() });
export type Profile = Infer<typeof ProfileSchema>;

export const BalanceSchema = s.object({ credits: s.number(), plan: s.enum(['free', 'pro']) });

export const DocsListEndpoint = defineEndpoint({
  id: 'docs/list',
  path: () => '/docs',
  query: (input: { readonly cursor: string | undefined }) => ({ cursor: input.cursor }),
  response: DocsPageSchema,
});

export const DocGetEndpoint = defineEndpoint({
  id: 'docs/get',
  path: (input: { readonly id: string }) => `/docs/${input.id}`,
  response: DocumentSchema,
});

export const DocSaveEndpoint = defineEndpoint({
  id: 'docs/save',
  method: 'POST',
  path: (input: { readonly id: string; readonly title: string; readonly blocks: readonly BlockRecord[] }) => `/docs/${input.id}`,
  body: (input: { readonly id: string; readonly title: string; readonly blocks: readonly BlockRecord[] }) => ({ title: input.title, blocks: input.blocks }),
  idempotent: true,
  response: s.object({ savedAt: s.number() }),
});

export const UserBatchProfilesEndpoint = defineEndpoint({
  id: 'users/batch-profiles',
  method: 'POST',
  path: () => '/users/batch',
  body: (ids: readonly string[]) => ({ ids }),
  idempotent: true,
  response: s.array(ProfileSchema),
});

export const ReplyChunkSchema = s.union(
  s.object({ type: s.literal('text'), delta: s.string() }),
  s.object({ type: s.literal('tool'), name: s.string(), input: s.record(s.unknown()) }),
  s.object({ type: s.literal('done') }),
);
export type ReplyChunk = Infer<typeof ReplyChunkSchema>;

export const AgentReplyEndpoint = defineStreamEndpoint({
  id: 'agent/reply',
  method: 'POST',
  path: () => '/agent/reply',
  body: (input: { readonly prompt: string; readonly docId: string | undefined }) => input,
  chunk: ReplyChunkSchema,
  // The agent backend gets its own breaker (FEATURE-NEEDS: "breaker on `agent` endpoint").
  breaker: { failureThreshold: 3, resetAfterMs: 10_000 },
});

export const BillingBalanceEndpoint = defineEndpoint({ id: 'billing/balance', path: () => '/billing/balance', response: BalanceSchema });

export const MeterReserveEndpoint = defineEndpoint({
  id: 'billing/reserve',
  method: 'POST',
  path: () => '/billing/reservations',
  body: (input: { readonly meter: string; readonly amount: number }) => input,
  response: s.object({ reservationId: s.string(), balance: s.number() }),
});
export const MeterCommitEndpoint = defineEndpoint({
  id: 'billing/commit',
  method: 'POST',
  path: (input: { readonly reservationId: string; readonly actual: number }) => `/billing/reservations/${input.reservationId}/commit`,
  body: (input: { readonly reservationId: string; readonly actual: number }) => ({ actual: input.actual }),
  response: s.object({ balance: s.number() }),
});
export const MeterReleaseEndpoint = defineEndpoint({
  id: 'billing/release',
  method: 'POST',
  path: (input: { readonly reservationId: string }) => `/billing/reservations/${input.reservationId}/release`,
  response: s.object({ balance: s.number() }),
});

export const UpgradePlanEndpoint = defineEndpoint({
  id: 'billing/upgrade',
  method: 'POST',
  path: () => '/billing/upgrade',
  body: (input: { readonly plan: 'pro' }) => input,
  response: BalanceSchema,
});

export const RemoteFlagsEndpoint = defineEndpoint({
  id: 'config/remote-flags',
  path: () => '/flags',
  query: (input: { readonly user: string | undefined }) => ({ user: input.user }),
  response: s.record(s.unknown()),
});

export const ExportPdfEndpoint = defineEndpoint({
  id: 'docs/export-pdf',
  method: 'POST',
  path: (input: { readonly id: string }) => `/docs/${input.id}/export`,
  response: s.object({ url: s.string() }),
});

// ------------------------------------------------------------------ resources

export const DocsListResource = definePaginatedResource({
  id: 'docs/list-resource',
  endpoint: DocsListEndpoint,
  key: () => ['docs'],
  request: (_input: null, cursor: string | undefined) => ({ cursor }),
  pagination: cursorPagination<DocsPage, DocSummary>({ items: (page) => page.items, nextCursor: (page) => page.nextCursor }),
  staleTimeMs: 30_000,
});

export const DocResource = defineResource({ id: 'docs/get-resource', endpoint: DocGetEndpoint, key: (input) => [input.id] });

export const ProfilesResource = defineBatchedResource<string, readonly Profile[], Profile>({
  id: 'users/profiles-resource',
  endpoint: UserBatchProfilesEndpoint,
  pick: (response, key) => response.find((p) => p.id === key),
  keyId: (key) => key,
  staleTimeMs: 60_000,
});

export const AgentReplyResource = defineStreamResource({
  id: 'agent/reply-resource',
  endpoint: AgentReplyEndpoint,
  initial: (): readonly ReplyChunk[] => [],
  reduce: (acc: readonly ReplyChunk[], chunk: ReplyChunk) => [...acc, chunk],
});
