import { createMemorySink, createTelemetry, err, ok, type Result } from '@staticflux/core';
import { createFakeGpu } from '@staticflux/testkit';
import { describe, expect, it } from 'vitest';
import { createGpuDevice, type GpuDeviceHandle, type GpuDeviceProvider, GpuDeviceLifecycle, readGpuLimits, webGpuDeviceProvider } from './gpu-device.js';
import { RasterBackendError } from './raster-errors.js';
import { createMemoryRasterBackend } from './memory-raster-backend.js';

const flush = async (turns = 10): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const instantSleep = async (): Promise<void> => undefined;

describe('webGpuDeviceProvider (fake GPU)', () => {
  it('requests a fresh adapter per acquire and reports adapter + device facts', async () => {
    const fake = createFakeGpu({ adapter: { info: { architecture: 'swiftshader', isFallbackAdapter: true }, features: ['timestamp-query', 'shader-f16'], limits: { maxTextureDimension2D: 16384 } } });
    const provider = webGpuDeviceProvider({ gpu: fake.gpu, optionalFeatures: ['shader-f16', 'float32-filterable'], requiredLimits: 'adapter', label: 'test' });
    const first = await provider.acquire({ signal: new AbortController().signal });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.facts.adapter).toMatchObject({ status: 'available', isFallbackAdapter: true, info: { architecture: 'swiftshader' } });
    expect(first.value.facts.features).toEqual(['shader-f16']); // only what the adapter has
    expect(first.value.facts.limits['maxTextureDimension2D']).toBe(16384); // asked for the adapter's limits
    const second = await provider.acquire({ signal: new AbortController().signal });
    expect(second.ok).toBe(true);
    expect(fake.adapters).toHaveLength(2); // never reuses a consumed adapter
    expect(fake.devices).toHaveLength(2);
  });

  it('reports a missing API, a null adapter, missing features and requestDevice failures as SF-SURF-010', async () => {
    const signal = new AbortController().signal;
    const none = await webGpuDeviceProvider({ gpu: undefined }).acquire({ signal });
    expect(!none.ok && none.error.code).toBe('SF-SURF-010');
    const fake = createFakeGpu({ adapter: false });
    const nullAdapter = await webGpuDeviceProvider({ gpu: fake.gpu }).acquire({ signal });
    expect(!nullAdapter.ok && nullAdapter.error.details['status']).toBe('no-adapter');
    fake.setAdapter({});
    const missing = await webGpuDeviceProvider({ gpu: fake.gpu, requiredFeatures: ['texture-compression-bc'] }).acquire({ signal });
    expect(!missing.ok && missing.error.details['status']).toBe('missing-features');
    fake.failNextRequestDevice();
    const failed = await webGpuDeviceProvider({ gpu: fake.gpu }).acquire({ signal });
    expect(!failed.ok && failed.error.details['status']).toBe('request-device-failed');
    const throwing = await webGpuDeviceProvider({ gpu: { requestAdapter: () => Promise.reject(new Error('blocked')) } }).acquire({ signal });
    expect(!throwing.ok && throwing.error.code).toBe('SF-SURF-010');
  });

  it('destroys the device when aborted while it was requested', async () => {
    const fake = createFakeGpu();
    const controller = new AbortController();
    const pending = webGpuDeviceProvider({ gpu: fake.gpu }).acquire({ signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it('readGpuLimits walks prototype accessors', () => {
    class Limits {
      get maxTextureDimension2D(): number {
        return 4096;
      }
    }
    expect(readGpuLimits(new Limits())).toEqual({ maxTextureDimension2D: 4096 });
    expect(readGpuLimits(undefined)).toEqual({});
  });
});

describe('createGpuDevice lifecycle (SF-Δ23)', () => {
  it('idle → attaching → running, with facts', async () => {
    const fake = createFakeGpu();
    const device = createGpuDevice({ id: 'test', provider: webGpuDeviceProvider({ gpu: fake.gpu }) });
    expect(device.state).toBe('idle');
    const states: string[] = [];
    device.machine.onTransition((r) => states.push(r.to));
    const facts = await device.attach();
    expect(facts.ok).toBe(true);
    expect(states).toEqual(['attaching', 'running']);
    expect(device.facts?.adapter.status).toBe('available');
    expect((await device.attach()).ok).toBe(true); // already running: no new device
    expect(fake.devices).toHaveLength(1);
    expect(GpuDeviceLifecycle.id).toBe('surface/gpu-device');
    device.dispose();
  });

  it('device.lost → lost → attaching → running on a NEW adapter, rebuilt by restore()', async () => {
    const fake = createFakeGpu();
    const clock = fakeClock();
    const restores: { recovery: boolean }[] = [];
    const device = createGpuDevice({
      id: 'canvas',
      provider: webGpuDeviceProvider({ gpu: fake.gpu }),
      restore: (handle, ctx) => {
        restores.push({ recovery: ctx.recovery });
        const raw = handle.device as { createRenderPipeline(d: unknown): unknown };
        raw.createRenderPipeline({ label: 'compositor', layout: 'auto', vertex: {} });
        clock.advance(120);
        return ok(undefined);
      },
      now: clock.now,
      sleep: instantSleep,
    });
    await device.attach();
    const states: string[] = [];
    device.machine.onTransition((r) => states.push(r.to));
    const lost: string[] = [];
    device.onLost((loss) => lost.push(loss.reason));
    const recovered = new Promise<{ ms: number; attempts: number }>((resolve) => device.onRecovered(resolve));
    fake.loseDevice();
    const record = await recovered;
    expect(lost).toEqual(['unknown']);
    expect(states).toEqual(['lost', 'attaching', 'running']);
    expect(record).toMatchObject({ attempts: 1, ms: 120, ok: true, overBudget: false });
    expect(fake.adapters).toHaveLength(2);
    expect(fake.devices).toHaveLength(2);
    expect(fake.callsTo('createRenderPipeline', 'device')).toHaveLength(2); // pipelines rebuilt from retained state
    expect(restores).toEqual([{ recovery: false }, { recovery: true }]);
    expect(fake.uncapturedErrors).toEqual([]);
    expect((await device.whenRunning()).ok).toBe(true);
    device.dispose();
  });

  it('retries with back-off when re-attaching fails, then recovers', async () => {
    const fake = createFakeGpu();
    const sleeps: number[] = [];
    const device = createGpuDevice({
      id: 'retry',
      provider: webGpuDeviceProvider({ gpu: fake.gpu }),
      recovery: { maxAttempts: 3, backoffMs: [0, 50, 200] },
      sleep: async (ms) => void sleeps.push(ms),
    });
    await device.attach();
    const states: string[] = [];
    device.machine.onTransition((r) => states.push(r.to));
    fake.failNextRequestDevice();
    const recovered = new Promise((resolve) => device.onRecovered(resolve));
    fake.loseDevice();
    await recovered;
    expect((await device.whenRunning()).ok).toBe(true);
    expect(states).toEqual(['lost', 'attaching', 'failed', 'attaching', 'running']);
    expect(sleeps).toEqual([50]);
    expect(device.recoveries()).toMatchObject([{ attempts: 2, ok: true }]);
    device.dispose();
  });

  it('gives up after maxAttempts with SF-SURF-011 and can be retried by hand', async () => {
    const fake = createFakeGpu();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    const device = createGpuDevice({ id: 'giveup', provider: webGpuDeviceProvider({ gpu: fake.gpu }), recovery: { maxAttempts: 2 }, sleep: instantSleep, telemetry });
    await device.attach();
    fake.setAdapter(false);
    const recovered = new Promise((resolve) => device.onRecovered(resolve));
    fake.loseDevice();
    await flush();
    const waiting = device.whenRunning(); // during recovery: waits for the outcome
    await recovered;
    const result = await waiting;
    expect(!result.ok && result.error.code).toBe('SF-SURF-011');
    expect(device.state).toBe('failed');
    expect(device.recoveries()).toMatchObject([{ attempts: 2, ok: false }]);
    const failedNow = await device.whenRunning();
    expect(!failedNow.ok && failedNow.error.code).toBe('SF-SURF-011');
    expect(sink.records.some((r) => r.type === 'event' && r.name === 'surface.gpu-recovery-failed')).toBe(true);
    fake.setAdapter({});
    expect((await device.attach()).ok).toBe(true);
    expect(device.state).toBe('running');
    device.dispose();
  });

  it('flags a recovery over the 1 s budget (SF-SURF-012) but still completes it', async () => {
    const fake = createFakeGpu();
    const clock = fakeClock();
    const sink = createMemorySink();
    const telemetry = createTelemetry({ defaultLevel: 'debug' });
    telemetry.addSink(sink);
    let slow = false;
    const device = createGpuDevice({
      id: 'slow',
      provider: webGpuDeviceProvider({ gpu: fake.gpu }),
      restore: () => {
        if (slow) clock.advance(1500);
        return ok(undefined);
      },
      now: clock.now,
      sleep: instantSleep,
      telemetry,
    });
    await device.attach();
    slow = true;
    const recovered = new Promise((resolve) => device.onRecovered(resolve));
    fake.loseDevice();
    expect(await recovered).toMatchObject({ ok: true, overBudget: true, ms: 1500 });
    const over = sink.records.find((r) => r.type === 'event' && r.name === 'surface.gpu-recovery-over-budget');
    expect(over).toBeDefined();
    expect(sink.records.some((r) => r.type === 'metric' && r.metric === 'surface/gpu-recovery')).toBe(true);
    device.dispose();
  });

  it('a failed first attach goes to failed (SF-SURF-010); restore errors destroy the new device', async () => {
    const fake = createFakeGpu({ adapter: false });
    const device = createGpuDevice({ id: 'none', provider: webGpuDeviceProvider({ gpu: fake.gpu }) });
    const first = await device.attach();
    expect(!first.ok && first.error.code).toBe('SF-SURF-010');
    expect(device.state).toBe('failed');
    const waiting = await device.whenRunning();
    expect(waiting.ok).toBe(false);

    const fake2 = createFakeGpu();
    const failing = createGpuDevice({ id: 'restore', provider: webGpuDeviceProvider({ gpu: fake2.gpu }), restore: () => err(RasterBackendError({ message: 'pipelines failed' })) });
    const result = await failing.attach();
    expect(!result.ok && result.error.code).toBe('SF-SURF-014');
    expect(fake2.devices[0]?.isLost).toBe(true);
    const throwing = createGpuDevice({ id: 'throws', provider: webGpuDeviceProvider({ gpu: fake2.gpu }), restore: () => {
      throw new Error('boom');
    } });
    expect((await throwing.attach()).ok).toBe(false);
  });

  it('dispose destroys the device without starting recovery, and settles waiters', async () => {
    const fake = createFakeGpu();
    const device = createGpuDevice({ id: 'dispose', provider: webGpuDeviceProvider({ gpu: fake.gpu }) });
    await device.attach();
    device.dispose();
    device.dispose();
    await flush();
    expect(device.state).toBe('disposed');
    expect(fake.devices[0]?.isLost).toBe(true);
    expect(fake.devices).toHaveLength(1);
    expect((await device.whenRunning()).ok).toBe(false);
    expect((await device.attach()).ok).toBe(false);
  });

  it('whenRunning honours an abort signal; attach can be aborted', async () => {
    let release!: (r: Result<GpuDeviceHandle>) => void;
    const provider: GpuDeviceProvider = { acquire: () => new Promise((resolve) => (release = resolve)) };
    const device = createGpuDevice({ id: 'abort', provider });
    const controller = new AbortController();
    const attaching = device.attach({ signal: controller.signal });
    const waiter = new AbortController();
    const waiting = device.whenRunning(waiter.signal);
    waiter.abort();
    expect((await waiting).ok).toBe(false);
    controller.abort();
    let destroyed = false;
    release(ok({ facts: { adapter: { status: 'available', info: { vendor: '', architecture: '', device: '', description: '' }, isFallbackAdapter: false, features: [], limits: {} }, features: [], limits: {} }, lost: new Promise(() => undefined), destroy: () => (destroyed = true) }));
    const result = await attaching;
    expect(result.ok).toBe(false);
    expect(destroyed).toBe(true);
    expect(device.state).toBe('failed');
  });

  it('works with a backend-owned device (memory backend as the provider)', async () => {
    const backend = createMemoryRasterBackend();
    const device = createGpuDevice({ id: 'backend', provider: { acquire: (o) => backend.attach(o) }, sleep: instantSleep });
    await device.attach();
    const recovered = new Promise((resolve) => device.onRecovered(resolve));
    backend.lose();
    await recovered;
    expect(backend.devices).toBe(2);
    expect(device.state).toBe('running');
    device.dispose();
  });
});
