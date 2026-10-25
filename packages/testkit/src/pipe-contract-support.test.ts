import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeHandle } from './handle-channel-contract.js';
import {
  availableLinkTransports,
  availablePipeMedia,
  eventually,
  inProcessLinks,
  mediumOptions,
  messageChannelLinks,
  PIPE_CONTRACT_MEDIA,
  settle,
} from './pipe-contract-support.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pipe contract support', () => {
  it('lists media and drops shared memory where SharedArrayBuffer is missing', () => {
    expect(availablePipeMedia().map((m) => m.medium)).toEqual(['local', 'shared', 'message']);
    vi.stubGlobal('SharedArrayBuffer', undefined);
    expect(availablePipeMedia(PIPE_CONTRACT_MEDIA).map((m) => m.medium)).toEqual(['local', 'message']);
  });

  it('passes a custom channel through mediumOptions', () => {
    const channel = (): never => {
      throw new Error('unused');
    };
    expect(mediumOptions({ name: 'm', medium: 'message', channel })).toEqual({ medium: 'message', channel });
    expect(mediumOptions({ name: 'l', medium: 'local' })).toEqual({ medium: 'local' });
  });

  it('link transports deliver both ways and close', async () => {
    expect(availableLinkTransports()).toEqual([inProcessLinks, messageChannelLinks]);
    for (const transport of availableLinkTransports()) {
      const { a, b, close } = transport.pair();
      const got: unknown[] = [];
      b.on('test/ping', (payload) => got.push(payload));
      a.send('test/ping', { n: 1 });
      await eventually(() => got.length === 1, 1_000, transport.name);
      close();
      expect(a.closed).toBe(true);
    }
    vi.stubGlobal('MessageChannel', undefined);
    expect(availableLinkTransports()).toEqual([inProcessLinks]);
  });

  it('settle waits for timers; eventually reports conditions that never hold', async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    await settle(2);
    expect(fired).toBe(true);
    await expect(eventually(() => false, 5, 'never')).rejects.toThrow(/never: condition not met within 5 ms/);
  });

  it('fake handles have the shapes classifyHandle recognises', async () => {
    const { classifyHandle } = await import('@staticflux/worker/pipeline');
    for (const kind of ['video-frame', 'audio-data', 'image-bitmap', 'offscreen-canvas', 'file-system-handle'] as const) {
      expect(classifyHandle(createFakeHandle(kind))).toBe(kind);
    }
    const frame = createFakeHandle('video-frame') as unknown as { close(): void; closed: boolean };
    frame.close();
    expect(frame.closed).toBe(true);
  });
});
