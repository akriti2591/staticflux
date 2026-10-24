/**
 * Agent chat — headless logic (no DOM): a schema-first `ChatStore` (snapshots +
 * patches, replicable) and the controller that streams replies from the mock agent
 * endpoint and runs its tool calls through the capability pipeline as subject `agent`
 * (gated with agent policies, confirmed when destructive, credits reserved → committed).
 */
import { err, ok, type Result, token, unit, untracked } from '@staticflux/core';
import { CapabilityRegistryToken } from '@staticflux/capabilities';
import { DataClientToken, defineStore, type Infer, type OwnerStore, s, storeUnit } from '@staticflux/data';
import { DocumentStoreToken } from '../../app/contracts.js';
import { AgentReplyEndpoint, type ReplyChunk } from '../../app/endpoints.js';

const MessageSchema = s.object({
  id: s.string(),
  role: s.enum(['user', 'assistant', 'tool']),
  text: s.string(),
  ok: s.optional(s.boolean()),
});
export type ChatMessage = Infer<typeof MessageSchema>;

const ChatStateSchema = s.object({
  messages: s.array(MessageSchema),
  draft: s.string(),
  status: s.enum(['idle', 'streaming', 'error']),
});
export type ChatState = Infer<typeof ChatStateSchema>;

export const ChatStore = defineStore({
  id: 'agent/chat',
  version: 1,
  schema: ChatStateSchema,
  initial: (): ChatState => ({ messages: [], draft: '', status: 'idle' }),
  actions: {
    append(state: ChatState, message: ChatMessage) {
      state.messages.push(message);
    },
    appendDelta(state: ChatState, id: string, delta: string) {
      const message = state.messages.find((m) => m.id === id);
      if (message !== undefined) message.text += delta;
    },
    setDraft(state: ChatState, text: string) {
      state.draft = text;
    },
    setStatus(state: ChatState, status: ChatState['status']) {
      state.status = status;
    },
  },
});

export type ChatStoreInstance = OwnerStore<ChatState, (typeof ChatStore)['actions']>;
export const ChatStoreToken = /* @__PURE__ */ token('agent/chat-store').type<ChatStoreInstance>();

export const chatStoreUnit = storeUnit({ id: 'agent/chat-store-unit', store: ChatStore, provides: ChatStoreToken, scope: 'feature' });

export interface ChatController {
  readonly store: ChatStoreInstance;
  /** Send the draft (or `prompt`). Never called automatically for URL intents (prefill only, I-13). */
  send(prompt?: string): Promise<Result<void>>;
}
export const ChatControllerToken = /* @__PURE__ */ token('agent/chat-controller').type<ChatController>();

type ToolCall = Extract<ReplyChunk, { readonly type: 'tool' }>;

export const chatControllerUnit = unit({
  id: 'agent/chat-controller-unit',
  provides: ChatControllerToken,
  scope: 'feature',
  deps: { required: { store: ChatStoreToken, client: DataClientToken, registry: CapabilityRegistryToken, doc: DocumentStoreToken } },
  create: ({ store, client, registry, doc }, ctx): ChatController => {
    let counter = 0;
    const nextId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
    return {
      store,
      async send(prompt) {
        const text = (prompt ?? untracked(() => store.state.draft)).trim();
        if (text === '' || untracked(() => store.state.status) === 'streaming') return ok();
        store.actions.append({ id: nextId('u'), role: 'user', text });
        store.actions.setDraft('');
        store.actions.setStatus('streaming');
        const replyId = nextId('a');
        store.actions.append({ id: replyId, role: 'assistant', text: '' });
        const tools: ToolCall[] = [];
        const streamed = await client.stream(
          AgentReplyEndpoint,
          { prompt: text, docId: untracked(() => doc.docId) },
          (chunk) => {
            if (chunk.type === 'text') store.actions.appendDelta(replyId, chunk.delta);
            else if (chunk.type === 'tool') tools.push(chunk);
          },
          { signal: ctx.signal },
        );
        if (!streamed.ok) {
          store.actions.setStatus('error');
          return err(streamed.error);
        }
        for (const tool of tools) {
          // One pipeline for agents: validate → authorize(agent) → confirm → activate → reserve → run → commit.
          const result = await registry.invoke(tool.name, tool.input, { subject: 'agent', origin: { channel: 'agent/chat' }, signal: ctx.signal });
          store.actions.append({
            id: nextId('t'),
            role: 'tool',
            text: result.ok ? `${tool.name} ✓` : `${tool.name} ✗ ${result.error.code}: ${result.error.message}`,
            ok: result.ok,
          });
        }
        store.actions.setStatus('idle');
        return ok();
      },
    };
  },
  description: 'Streams agent replies; tool calls are capabilities invoked as the agent subject.',
});
