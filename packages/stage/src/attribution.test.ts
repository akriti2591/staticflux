import type { RunContext } from '@staticflux/capabilities';
import { createInjector } from '@staticflux/core';
import { describe, expect, it } from 'vitest';
import { actorOf } from './actor.js';
import { AttributionPortToken, CHANNEL_VIA, createAttributionPort, defaultAgentIdentity, metaForRun, type RunSource, SUBJECT_KIND } from './attribution.js';
import { attributionPortUnit } from './units.js';
import { unwrap } from './test-helpers.js';

const human = () => ({ id: 'g-1', displayName: 'You' });

describe('attribution port (RunContext → actor → transact meta)', () => {
  it('maps a human run (palette) to a human actor with via and invocation', () => {
    const port = createAttributionPort({ human });
    const actor = unwrap(port.actorFor({ invocationId: 'inv-1', subject: 'user', origin: { channel: 'shell/palette' } }));
    expect(actor).toEqual({ kind: 'human', id: 'g-1', displayName: 'You', via: 'bar', invocationId: 'inv-1' });
    expect(unwrap(port.actorFor({ subject: 'guest', origin: undefined })).via).toBe('direct');
  });

  it('names agents from origin details or the WebMCP client, acting for the human', () => {
    const port = createAttributionPort({ human });
    const named = unwrap(port.actorFor({ invocationId: 'i', subject: 'agent', origin: { channel: 'ui/chat', details: { agent: { id: 'ag-7', displayName: 'Claude', model: 'claude-x' } } } }));
    expect(named).toEqual({ kind: 'agent', id: 'ag-7', displayName: 'Claude', model: 'claude-x', via: 'chat', invocationId: 'i', onBehalfOf: 'g-1' });
    const webmcp = unwrap(port.actorFor({ subject: 'agent', origin: { channel: 'webmcp', details: { tool: 'align', client: { name: 'Desktop agent' } } } }));
    expect(webmcp).toMatchObject({ kind: 'agent', id: 'webmcp:Desktop agent', displayName: 'Desktop agent', via: 'webmcp' });
    const anonymous = port.actorFor({ subject: 'agent', origin: { channel: 'webmcp', details: { tool: 'align' } } });
    expect(anonymous.ok ? '' : anonymous.error.code).toBe('SF-STAGE-004');
  });

  it('maps system runs to flows and rejects unknown subjects', () => {
    const port = createAttributionPort({ human, via: (channel) => (channel === 'custom' ? 'hud' : undefined) });
    const flow = unwrap(port.actorFor({ subject: 'system', origin: { channel: 'custom', details: { flow: { id: 'as_flow' } } } }));
    expect(flow).toEqual({ kind: 'flow', id: 'as_flow', displayName: 'as_flow', via: 'hud', onBehalfOf: 'g-1' });
    expect(unwrap(port.actorFor({ subject: 'system', origin: { channel: 'flow', details: { flow: { id: 'f', displayName: 'Batch' } } } })).via).toBe('flow');
    const unknown = port.actorFor({ subject: 'robot' });
    expect(unknown.ok ? '' : unknown.error.details?.['subject']).toBe('robot');
    const custom = createAttributionPort({ human, agent: () => ({ id: 'a', displayName: 'A' }), flow: () => undefined });
    expect(unwrap(custom.actorFor({ subject: 'plugin' })).id).toBe('a');
    expect(custom.actorFor({ subject: 'system' }).ok).toBe(false);
  });

  it('default agent identity falls back to the channel name', () => {
    expect(defaultAgentIdentity({ subject: 'agent', origin: { channel: 'x', details: { client: { name: 'N' } } } })).toEqual({ id: 'x:N', displayName: 'N' });
    expect(defaultAgentIdentity({ subject: 'agent', origin: { channel: 'x', details: { agent: { id: 'id-only' } } } })).toEqual({ id: 'id-only', displayName: 'id-only' });
    expect(defaultAgentIdentity({ subject: 'agent' })).toBeUndefined();
    expect(CHANNEL_VIA['webmcp']).toBe('webmcp');
    expect(SUBJECT_KIND['plugin']).toBe('agent');
  });

  it('metaForRun builds attributed transaction meta in one step', () => {
    const port = createAttributionPort({ human });
    const meta = unwrap(metaForRun(port, { invocationId: 'inv-2', subject: 'user', origin: { channel: 'ui/hud' } }, 'Align left', { changeSet: 'cs_2' }));
    expect(meta).toMatchObject({ label: 'Align left', via: 'hud', invocation: 'inv-2', changeSet: 'cs_2' });
    expect(actorOf(meta)?.id).toBe('g-1');
    expect(metaForRun(port, { subject: 'robot' }, 'x').ok).toBe(false);
  });

  it('accepts a capabilities RunContext as a RunSource', () => {
    const run = { invocationId: 'inv', subject: 'agent', origin: { channel: 'webmcp', details: { client: { name: 'C' } } } } as unknown as RunContext;
    const source: RunSource = run;
    expect(unwrap(createAttributionPort({ human }).actorFor(source)).id).toBe('webmcp:C');
  });

  it('is provided by a unit under its token', async () => {
    const injector = createInjector({ units: [attributionPortUnit({ id: 'test/attribution', port: { human } })] });
    const port = await injector.get(AttributionPortToken);
    expect(port.ok && unwrap(port.value.actorFor({ subject: 'user' })).id).toBe('g-1');
  });
});
