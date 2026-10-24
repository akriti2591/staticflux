/**
 * Remote LLM adapter (R19.17): any chat-completion backend behind
 * `RemoteLlmTransport` (fetch to a BFF, host bridge in embedded mode, …).
 * The transport owns auth and endpoints; this adapter only shapes prompts.
 *
 * Remote models are opt-in per app; send only what the feature declares.
 */
import { anySignal, createNoopTelemetry, ok, type Result, type Telemetry } from '@staticflux/core';
import { type CompleteJson, promptDecide, promptDetectLanguage } from './decision-model.js';
import { type AiTask, createAiFactsStore, instrument, type ModelProvider, unsupported } from './provider.js';

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LlmCompletionRequest {
  readonly messages: readonly LlmMessage[];
  /** JSON schema the reply must match (structured output), when the backend supports it. */
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  readonly maxTokens?: number;
}

export interface RemoteLlmTransport {
  complete(request: LlmCompletionRequest, signal: AbortSignal): Promise<Result<{ readonly text: string }>>;
}

export interface RemoteLlmProviderOptions {
  readonly id: string;
  readonly transport: RemoteLlmTransport;
  /** Tasks this backend may serve. Default: all. */
  readonly tasks?: readonly AiTask[];
  readonly maxTokens?: number;
  readonly telemetry?: Telemetry;
}

const ALL: readonly AiTask[] = ['generate', 'summarize', 'translate', 'detect-language', 'decide'];

const SUMMARY_STYLE = {
  'key-points': 'as concise bullet key points',
  tldr: 'as a short TL;DR',
  teaser: 'as an enticing teaser',
  headline: 'as a single headline',
} as const;

export function createRemoteLlmProvider(options: RemoteLlmProviderOptions): ModelProvider {
  const telemetry = options.telemetry ?? createNoopTelemetry();
  const tasks = new Set(options.tasks ?? ALL);
  const initial = Object.fromEntries(ALL.map((task) => [task, tasks.has(task) ? 'available' : 'unavailable'] as const));
  const facts = createAiFactsStore(options.id, initial, telemetry);
  const lifetime = new AbortController();

  const complete = async (messages: readonly LlmMessage[], signal: AbortSignal | undefined, schema?: Readonly<Record<string, unknown>>) =>
    options.transport.complete(
      {
        messages,
        ...(schema === undefined ? {} : { responseSchema: schema }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      },
      anySignal(signal, lifetime.signal),
    );

  const completeJson: CompleteJson = async (system, user, schema, signal) => {
    const reply = await complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      signal,
      schema,
    );
    return reply.ok ? ok(reply.value.text) : reply;
  };

  const text = async (system: string, user: string, signal: AbortSignal | undefined): Promise<Result<{ text: string }>> => {
    const reply = await complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      signal,
    );
    return reply.ok ? ok({ text: reply.value.text }) : reply;
  };

  return {
    id: options.id,
    kind: 'remote',
    facts,
    probe: () => Promise.resolve(ok(facts.get())),
    prepare: (task) => (tasks.has(task) ? Promise.resolve(ok()) : unsupported(options.id, task)),
    generate(request) {
      if (!tasks.has('generate')) return unsupported(options.id, 'generate');
      return instrument(telemetry, options.id, 'generate', async () => {
        const messages: LlmMessage[] = [];
        if (request.system !== undefined) messages.push({ role: 'system', content: request.system });
        messages.push({ role: 'user', content: request.prompt });
        const reply = await complete(messages, request.signal);
        return reply.ok ? ok({ text: reply.value.text }) : reply;
      });
    },
    summarize(request) {
      if (!tasks.has('summarize')) return unsupported(options.id, 'summarize');
      return instrument(telemetry, options.id, 'summarize', () =>
        text(
          `Summarize the user's text ${SUMMARY_STYLE[request.type ?? 'key-points']}, ${request.length ?? 'medium'} length, ` +
            `as ${request.format ?? 'plain-text'}.${request.context === undefined ? '' : ` Context: ${request.context}`}`,
          request.text,
          request.signal,
        ),
      );
    },
    translate(request) {
      if (!tasks.has('translate')) return unsupported(options.id, 'translate');
      return instrument(telemetry, options.id, 'translate', () =>
        text(
          `Translate the user's text from ${request.from} to ${request.to}. Reply with the translation only.`,
          request.text,
          request.signal,
        ),
      );
    },
    detectLanguage(request) {
      if (!tasks.has('detect-language')) return unsupported(options.id, 'detect-language');
      return instrument(telemetry, options.id, 'detect-language', () => promptDetectLanguage(completeJson, request.text, request.signal));
    },
    decide(request) {
      if (!tasks.has('decide')) return unsupported(options.id, 'decide');
      return instrument(telemetry, options.id, 'decide', () => promptDecide(completeJson, request));
    },
    dispose() {
      lifetime.abort();
      return Promise.resolve();
    },
  };
}
