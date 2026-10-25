/**
 * A minimal, recording WebGPU fake for unit tests (`navigator.gpu` → adapter → device → queue,
 * command encoders, passes, buffers, textures and a `GPUCanvasContext`). No rendering: draw calls are
 * recorded only. What it does execute, so readback and recovery code can be tested in Node:
 *
 * - **Copies** at `queue.submit`: buffer↔buffer, texture↔buffer, texture↔texture, `clearBuffer`,
 *   `queue.writeBuffer` / `writeTexture`, and render-pass `loadOp: 'clear'` (8-bit RGBA/BGRA formats;
 *   `-srgb` formats store the clear color sRGB-encoded, as GPUs do). Texture bytes are kept for
 *   2-D, single-mip, single-sample textures with 4-byte texels; others are record-only.
 * - **Mapping**: `mapAsync` / `getMappedRange` / `unmap` with the spec's states, resolved after the
 *   queue drains (a microtask by default; `queue: 'manual'` + `flushQueue()` to control the order).
 * - **Validation errors** for the mistakes readback code makes: `bytesPerRow` not a multiple of 256,
 *   missing `COPY_SRC` / `COPY_DST` / `MAP_READ` usage, copies out of bounds, submitting a mapped or
 *   destroyed resource, using an expired canvas texture. Errors go to the innermost matching error
 *   scope, else to `uncapturederror` (and `fake.uncapturedErrors`).
 * - **Device loss**: `fake.loseDevice(device, reason)` or `device.destroy()` resolves `device.lost`
 *   once, rejects pending maps (AbortError), makes `submit` a no-op and stops error reporting.
 *   An adapter is **consumed** by its first `requestDevice`; asking it again rejects (OperationError),
 *   so recovery code must call `navigator.gpu.requestAdapter()` again — as on real browsers.
 * - **Limits and features**: adapters expose `info`, `features` and `limits` (spec defaults unless
 *   overridden); devices get only the features they request and the default limits unless
 *   `requiredLimits` asks for better ones (a classic "works on my GPU" bug).
 *
 * Nothing patches globals. Code that reads `GPUBufferUsage` etc. as globals can be given
 * `fake.globals` with `vi.stubGlobal`. Objects are plain records shaped like their WebGPU
 * counterparts; cast to your port's types (`as unknown as GPUDevice`) where needed.
 */
import { GPU_CONSTANTS } from './gpu-readback.js';

export const GPU_DEFAULT_LIMITS = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxBindGroupsPlusVertexBuffers: 24,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8,
  maxBufferSize: 268435456,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
} as const;

export type GpuLimitName = keyof typeof GPU_DEFAULT_LIMITS;
export type GpuLimits = { readonly [K in GpuLimitName]: number };

export interface FakeGpuAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly subgroupMinSize: number;
  readonly subgroupMaxSize: number;
  readonly isFallbackAdapter: boolean;
}

export const FAKE_ADAPTER_INFO: FakeGpuAdapterInfo = {
  vendor: 'staticflux',
  architecture: 'fake',
  device: '',
  description: 'StaticFlux testkit fake GPU',
  subgroupMinSize: 4,
  subgroupMaxSize: 128,
  isFallbackAdapter: false,
};

export interface FakeAdapterOptions {
  readonly info?: Partial<FakeGpuAdapterInfo>;
  readonly features?: readonly string[];
  /** Adapter limits; unspecified ones are the spec defaults. */
  readonly limits?: Partial<Record<GpuLimitName, number>>;
}

export interface FakeCompilationMessage {
  readonly type: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly lineNum?: number;
  readonly linePos?: number;
}

export interface FakeGpuOptions {
  /** What `requestAdapter` returns; `false` → `null` (no adapter). Changeable later with `setAdapter`. */
  readonly adapter?: FakeAdapterOptions | false;
  readonly preferredCanvasFormat?: 'bgra8unorm' | 'rgba8unorm';
  readonly wgslLanguageFeatures?: readonly string[];
  /** `'auto'` (default): map and work-done promises settle on a microtask. `'manual'`: only in `flushQueue()`. */
  readonly queue?: 'auto' | 'manual';
  /** Shader compiler stand-in: messages for `getCompilationInfo`; any `error` also raises a validation error. */
  readonly compile?: (code: string) => readonly FakeCompilationMessage[];
}

export interface GpuCall {
  readonly seq: number;
  /** `<kind>#<n>`, e.g. `device#1`, `encoder#3`, `render-pass#4`, `context#1`. */
  readonly target: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export type GpuErrorFilter = 'validation' | 'out-of-memory' | 'internal';

/** Error objects as WebGPU reports them (`GPUValidationError` etc.); stub the globals with `fake.globals` for `instanceof`. */
export class FakeGpuValidationError {
  readonly name = 'GPUValidationError';
  constructor(readonly message: string) {}
}
export class FakeGpuOutOfMemoryError {
  readonly name = 'GPUOutOfMemoryError';
  constructor(readonly message: string) {}
}
export class FakeGpuInternalError {
  readonly name = 'GPUInternalError';
  constructor(readonly message: string) {}
}
export type FakeGpuError = FakeGpuValidationError | FakeGpuOutOfMemoryError | FakeGpuInternalError;

export interface FakeGpuDeviceLostInfo {
  readonly reason: 'destroyed' | 'unknown';
  readonly message: string;
}

interface FakeObject {
  readonly fakeId: string;
  label: string;
}

export interface FakeGpuBuffer extends FakeObject {
  readonly size: number;
  readonly usage: number;
  readonly mapState: 'unmapped' | 'pending' | 'mapped';
  /** Test inspection: the buffer's bytes (live view). */
  readonly contents: Uint8Array;
  readonly destroyed: boolean;
  mapAsync(mode: number, offset?: number, size?: number): Promise<undefined>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

export interface FakeGpuTexture extends FakeObject {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly dimension: string;
  readonly format: string;
  readonly usage: number;
  /** Test inspection: texel bytes in memory order (BGRA for `bgra8*`), or `undefined` for record-only textures. */
  readonly contents: Uint8Array | undefined;
  readonly destroyed: boolean;
  createView(descriptor?: { readonly label?: string; readonly format?: string }): FakeGpuTextureView;
  destroy(): void;
}

export interface FakeGpuTextureView extends FakeObject {
  readonly texture: FakeGpuTexture;
}

export interface FakeGpuShaderModule extends FakeObject {
  readonly code: string;
  getCompilationInfo(): Promise<{ readonly messages: readonly FakeCompilationMessage[] }>;
}

export interface FakeGpuPipeline extends FakeObject {
  readonly descriptor: unknown;
  getBindGroupLayout(index: number): FakeObject;
}

export interface FakeGpuCommandBuffer extends FakeObject {
  readonly valid: boolean;
}

export interface FakeGpuRenderPass extends FakeObject {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, group: unknown, offsets?: unknown): void;
  setVertexBuffer(slot: number, buffer: unknown, offset?: number, size?: number): void;
  setIndexBuffer(buffer: unknown, format: string, offset?: number, size?: number): void;
  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  setBlendConstant(color: unknown): void;
  setStencilReference(reference: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
  drawIndirect(buffer: unknown, offset: number): void;
  drawIndexedIndirect(buffer: unknown, offset: number): void;
  executeBundles(bundles: unknown): void;
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  insertDebugMarker(label: string): void;
  end(): void;
}

export interface FakeGpuComputePass extends FakeObject {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, group: unknown, offsets?: unknown): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  dispatchWorkgroupsIndirect(buffer: unknown, offset: number): void;
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  insertDebugMarker(label: string): void;
  end(): void;
}

export type GpuExtent = readonly number[] | { readonly width: number; readonly height?: number; readonly depthOrArrayLayers?: number };
export type GpuOrigin = readonly number[] | { readonly x?: number; readonly y?: number; readonly z?: number };

export interface TexelCopyBuffer {
  readonly buffer: FakeGpuBuffer;
  readonly offset?: number;
  readonly bytesPerRow?: number;
  readonly rowsPerImage?: number;
}

export interface TexelCopyTexture {
  readonly texture: FakeGpuTexture;
  readonly mipLevel?: number;
  readonly origin?: GpuOrigin;
}

export interface FakeGpuCommandEncoder extends FakeObject {
  beginRenderPass(descriptor: {
    readonly label?: string;
    readonly colorAttachments: readonly ({ readonly view: FakeGpuTextureView; readonly loadOp: string; readonly storeOp: string; readonly clearValue?: unknown } | null)[];
    readonly depthStencilAttachment?: unknown;
  }): FakeGpuRenderPass;
  beginComputePass(descriptor?: { readonly label?: string }): FakeGpuComputePass;
  copyBufferToBuffer(source: FakeGpuBuffer, sourceOffset: number, destination: FakeGpuBuffer, destinationOffset: number, size: number): void;
  copyBufferToTexture(source: TexelCopyBuffer, destination: TexelCopyTexture, size: GpuExtent): void;
  copyTextureToBuffer(source: TexelCopyTexture, destination: TexelCopyBuffer, size: GpuExtent): void;
  copyTextureToTexture(source: TexelCopyTexture, destination: TexelCopyTexture, size: GpuExtent): void;
  clearBuffer(buffer: FakeGpuBuffer, offset?: number, size?: number): void;
  resolveQuerySet(querySet: unknown, firstQuery: number, queryCount: number, destination: unknown, destinationOffset: number): void;
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
  insertDebugMarker(label: string): void;
  finish(descriptor?: { readonly label?: string }): FakeGpuCommandBuffer;
}

export interface FakeGpuQueue extends FakeObject {
  submit(commandBuffers: readonly FakeGpuCommandBuffer[]): void;
  writeBuffer(buffer: FakeGpuBuffer, bufferOffset: number, data: ArrayBufferLike | ArrayBufferView, dataOffset?: number, size?: number): void;
  writeTexture(destination: TexelCopyTexture, data: ArrayBufferLike | ArrayBufferView, dataLayout: { readonly offset?: number; readonly bytesPerRow?: number; readonly rowsPerImage?: number }, size: GpuExtent): void;
  copyExternalImageToTexture(source: unknown, destination: unknown, copySize: GpuExtent): void;
  onSubmittedWorkDone(): Promise<undefined>;
}

export interface FakeGpuDevice extends FakeObject {
  readonly features: ReadonlySet<string>;
  readonly limits: GpuLimits;
  readonly adapterInfo: FakeGpuAdapterInfo;
  readonly queue: FakeGpuQueue;
  readonly lost: Promise<FakeGpuDeviceLostInfo>;
  /** Test inspection: true once lost or destroyed. */
  readonly isLost: boolean;
  onuncapturederror: ((event: Event & { readonly error: FakeGpuError }) => void) | null;
  createBuffer(descriptor: { readonly label?: string; readonly size: number; readonly usage: number; readonly mappedAtCreation?: boolean }): FakeGpuBuffer;
  createTexture(descriptor: {
    readonly label?: string;
    readonly size: GpuExtent;
    readonly format: string;
    readonly usage: number;
    readonly mipLevelCount?: number;
    readonly sampleCount?: number;
    readonly dimension?: string;
    readonly viewFormats?: readonly string[];
  }): FakeGpuTexture;
  createSampler(descriptor?: { readonly label?: string }): FakeObject;
  createShaderModule(descriptor: { readonly label?: string; readonly code: string }): FakeGpuShaderModule;
  createBindGroupLayout(descriptor: { readonly label?: string; readonly entries: readonly unknown[] }): FakeObject;
  createPipelineLayout(descriptor: { readonly label?: string; readonly bindGroupLayouts: readonly unknown[] }): FakeObject;
  createBindGroup(descriptor: { readonly label?: string; readonly layout: unknown; readonly entries: readonly unknown[] }): FakeObject;
  createRenderPipeline(descriptor: { readonly label?: string; readonly layout: unknown; readonly vertex: unknown }): FakeGpuPipeline;
  createComputePipeline(descriptor: { readonly label?: string; readonly layout: unknown; readonly compute: unknown }): FakeGpuPipeline;
  createRenderPipelineAsync(descriptor: { readonly label?: string; readonly layout: unknown; readonly vertex: unknown }): Promise<FakeGpuPipeline>;
  createComputePipelineAsync(descriptor: { readonly label?: string; readonly layout: unknown; readonly compute: unknown }): Promise<FakeGpuPipeline>;
  createCommandEncoder(descriptor?: { readonly label?: string }): FakeGpuCommandEncoder;
  createQuerySet(descriptor: { readonly label?: string; readonly type: string; readonly count: number }): FakeObject;
  pushErrorScope(filter: GpuErrorFilter): void;
  popErrorScope(): Promise<FakeGpuError | null>;
  destroy(): void;
  addEventListener(type: 'uncapturederror', listener: (event: Event & { readonly error: FakeGpuError }) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: 'uncapturederror', listener: (event: Event & { readonly error: FakeGpuError }) => void): void;
}

export interface FakeGpuAdapter {
  readonly fakeId: string;
  readonly features: ReadonlySet<string>;
  readonly limits: GpuLimits;
  readonly info: FakeGpuAdapterInfo;
  /** Deprecated in the spec but still read by older code; mirrors `info.isFallbackAdapter`. */
  readonly isFallbackAdapter: boolean;
  /** `valid` until the first successful `requestDevice`, then `consumed`. */
  readonly state: 'valid' | 'consumed';
  requestDevice(descriptor?: {
    readonly label?: string;
    readonly requiredFeatures?: readonly string[];
    readonly requiredLimits?: Partial<Record<string, number>>;
    readonly defaultQueue?: { readonly label?: string };
  }): Promise<FakeGpuDevice>;
}

/** `navigator.gpu` stand-in. */
export interface FakeGpuEntry {
  requestAdapter(options?: { readonly powerPreference?: string; readonly forceFallbackAdapter?: boolean; readonly featureLevel?: string }): Promise<FakeGpuAdapter | null>;
  getPreferredCanvasFormat(): string;
  readonly wgslLanguageFeatures: ReadonlySet<string>;
}

export interface FakeCanvasConfiguration {
  readonly device: FakeGpuDevice;
  readonly format: string;
  readonly usage?: number;
  readonly alphaMode?: 'opaque' | 'premultiplied';
  readonly colorSpace?: string;
  readonly viewFormats?: readonly string[];
}

export interface FakeGpuCanvasContext {
  readonly canvas: FakeGpuCanvas;
  configure(configuration: FakeCanvasConfiguration): void;
  unconfigure(): void;
  getConfiguration(): FakeCanvasConfiguration | null;
  getCurrentTexture(): FakeGpuTexture;
}

/** Canvas stand-in (`HTMLCanvasElement` / `OffscreenCanvas` shape): `getContext('webgpu')` returns the fake context. */
export interface FakeGpuCanvas {
  width: number;
  height: number;
  getContext(contextId: string, options?: unknown): FakeGpuCanvasContext | null;
}

export interface FakeCanvasHandle {
  readonly canvas: FakeGpuCanvas;
  readonly context: FakeGpuCanvasContext;
  /** End the frame: the current texture is presented and expires; the next `getCurrentTexture` returns a new one. */
  present(): FakeGpuTexture | undefined;
  /** Frames presented so far (textures that were acquired, then presented). */
  readonly presentedFrames: number;
  /** The most recently presented texture's bytes (or `undefined`). */
  readonly lastPresented: FakeGpuTexture | undefined;
}

export interface FakeGpu {
  /** Pass as `navigator.gpu` (e.g. `{ navigator: { gpu: fake.gpu } }` to code that takes globals). */
  readonly gpu: FakeGpuEntry;
  readonly calls: readonly GpuCall[];
  /** Calls whose method is `method`, optionally on targets of `kind` (`device`, `queue`, `encoder`, …). */
  callsTo(method: string, kind?: string): readonly GpuCall[];
  clearCalls(): void;
  readonly adapters: readonly FakeGpuAdapter[];
  readonly devices: readonly FakeGpuDevice[];
  /** Errors no error scope caught, in order. */
  readonly uncapturedErrors: readonly FakeGpuError[];
  /** What later `requestAdapter` calls return (`false` → `null`). */
  setAdapter(options: FakeAdapterOptions | false): void;
  /** Make the next `requestDevice` (on any adapter) reject with `error` (default an OperationError DOMException). */
  failNextRequestDevice(error?: unknown): void;
  /** Lose a device (default: the most recent one). Resolves its `lost` promise once. */
  loseDevice(device?: FakeGpuDevice, reason?: FakeGpuDeviceLostInfo['reason'], message?: string): void;
  /** Raise a GPU error on a device as if the implementation found it (goes through error scopes). */
  injectError(device: FakeGpuDevice, error: FakeGpuError): void;
  /** A canvas with a WebGPU context (default 300×150, the HTML canvas default). */
  createCanvas(size?: { readonly width?: number; readonly height?: number }): FakeCanvasHandle;
  /** Settle pending maps and `onSubmittedWorkDone` promises (needed with `queue: 'manual'`; harmless otherwise). */
  flushQueue(): void;
  /** WebGPU interface constants and error classes, for `vi.stubGlobal(name, value)` in code that reads globals. */
  readonly globals: {
    readonly GPUBufferUsage: typeof GPU_CONSTANTS.BufferUsage;
    readonly GPUTextureUsage: typeof GPU_CONSTANTS.TextureUsage;
    readonly GPUMapMode: typeof GPU_CONSTANTS.MapMode;
    readonly GPUShaderStage: typeof GPU_CONSTANTS.ShaderStage;
    readonly GPUColorWrite: typeof GPU_CONSTANTS.ColorWrite;
    readonly GPUValidationError: typeof FakeGpuValidationError;
    readonly GPUOutOfMemoryError: typeof FakeGpuOutOfMemoryError;
    readonly GPUInternalError: typeof FakeGpuInternalError;
  };
}

/** Texel formats whose bytes the fake stores (4 bytes per texel). */
const STORED_FORMATS = new Set(['rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm', 'bgra8unorm-srgb', 'rgba8snorm', 'rgba8uint', 'rgba8sint', 'r32float', 'r32uint', 'r32sint', 'rg16float', 'rg16uint', 'rg16sint', 'rgb10a2unorm']);
const CLEARABLE_FORMATS = new Set(['rgba8unorm', 'rgba8unorm-srgb', 'bgra8unorm', 'bgra8unorm-srgb']);
const { BufferUsage, TextureUsage, MapMode } = GPU_CONSTANTS;

type Op = () => void;

interface DeviceState {
  device: FakeGpuDevice;
  lost: boolean;
  resolveLost: (info: FakeGpuDeviceLostInfo) => void;
  scopes: { filter: GpuErrorFilter; error: FakeGpuError | null }[];
  events: EventTarget;
  pendingMaps: Set<{ reject: (e: unknown) => void }>;
}

export function createFakeGpu(options: FakeGpuOptions = {}): FakeGpu {
  const calls: GpuCall[] = [];
  const adapters: FakeGpuAdapter[] = [];
  const devices: FakeGpuDevice[] = [];
  const deviceStates = new Map<FakeGpuDevice, DeviceState>();
  const uncapturedErrors: FakeGpuError[] = [];
  const counters = new Map<string, number>();
  const pendingWork: Op[] = [];
  let adapterOptions: FakeAdapterOptions | false = options.adapter ?? {};
  let nextRequestDeviceFailure: { error: unknown } | undefined;
  let seq = 0;
  let flushScheduled = false;
  const manualQueue = options.queue === 'manual';

  const nextId = (kind: string): string => {
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    return `${kind}#${n}`;
  };
  const record = (target: string, method: string, args: readonly unknown[]): void => {
    calls.push({ seq: ++seq, target, method, args });
  };

  const flushQueue = (): void => {
    flushScheduled = false;
    while (pendingWork.length > 0) pendingWork.shift()!();
  };
  const enqueue = (op: Op): void => {
    pendingWork.push(op);
    if (!manualQueue && !flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flushQueue);
    }
  };

  const raise = (state: DeviceState, error: FakeGpuError): void => {
    if (state.lost) return; // a lost device reports no errors
    const filter: GpuErrorFilter = error instanceof FakeGpuValidationError ? 'validation' : error instanceof FakeGpuOutOfMemoryError ? 'out-of-memory' : 'internal';
    for (let i = state.scopes.length - 1; i >= 0; i--) {
      const scope = state.scopes[i]!;
      if (scope.filter === filter) {
        if (scope.error === null) scope.error = error;
        return;
      }
    }
    uncapturedErrors.push(error);
    const event = Object.assign(new Event('uncapturederror'), { error });
    state.events.dispatchEvent(event);
    state.device.onuncapturederror?.(event);
  };
  const invalid = (state: DeviceState, message: string): void => raise(state, new FakeGpuValidationError(message));

  const lose = (state: DeviceState, reason: FakeGpuDeviceLostInfo['reason'], message: string): void => {
    if (state.lost) return;
    state.lost = true;
    for (const pending of state.pendingMaps) pending.reject(new DOMException('Device was lost before the map completed.', 'AbortError'));
    state.pendingMaps.clear();
    state.resolveLost({ reason, message });
  };

  const makeAdapter = (spec: FakeAdapterOptions): FakeGpuAdapter => {
    const fakeId = nextId('adapter');
    const info: FakeGpuAdapterInfo = { ...FAKE_ADAPTER_INFO, ...spec.info };
    const features: ReadonlySet<string> = new Set(spec.features ?? []);
    const limits: GpuLimits = { ...GPU_DEFAULT_LIMITS, ...spec.limits };
    let state: 'valid' | 'consumed' = 'valid';
    const adapter: FakeGpuAdapter = {
      fakeId,
      features,
      limits,
      info,
      isFallbackAdapter: info.isFallbackAdapter,
      get state() {
        return state;
      },
      requestDevice(descriptor = {}) {
        record(fakeId, 'requestDevice', [descriptor]);
        if (nextRequestDeviceFailure !== undefined) {
          const { error } = nextRequestDeviceFailure;
          nextRequestDeviceFailure = undefined;
          return Promise.reject(error);
        }
        if (state === 'consumed') {
          return Promise.reject(new DOMException('The adapter was already used to create a device; request a new adapter.', 'OperationError'));
        }
        for (const feature of descriptor.requiredFeatures ?? []) {
          if (!features.has(feature)) return Promise.reject(new TypeError(`Feature "${feature}" is not supported by the adapter.`));
        }
        const deviceLimits: Record<string, number> = { ...GPU_DEFAULT_LIMITS };
        for (const [name, value] of Object.entries(descriptor.requiredLimits ?? {})) {
          if (value === undefined) continue;
          if (!(name in GPU_DEFAULT_LIMITS)) return Promise.reject(new DOMException(`Unknown limit "${name}".`, 'OperationError'));
          const adapterValue = limits[name as GpuLimitName];
          const isAlignment = name.startsWith('min');
          if (isAlignment ? value < adapterValue : value > adapterValue) {
            return Promise.reject(new DOMException(`Required limit ${name} = ${value} exceeds the adapter's ${adapterValue}.`, 'OperationError'));
          }
          const base = GPU_DEFAULT_LIMITS[name as GpuLimitName];
          deviceLimits[name] = isAlignment ? Math.min(base, value) : Math.max(base, value);
        }
        state = 'consumed';
        return Promise.resolve(makeDevice(info, new Set(descriptor.requiredFeatures ?? []), deviceLimits as GpuLimits, descriptor.label ?? '', descriptor.defaultQueue?.label ?? ''));
      },
    };
    adapters.push(adapter);
    return adapter;
  };

  const makeDevice = (adapterInfo: FakeGpuAdapterInfo, features: ReadonlySet<string>, limits: GpuLimits, label: string, queueLabel: string): FakeGpuDevice => {
    const fakeId = nextId('device');
    let resolveLost!: (info: FakeGpuDeviceLostInfo) => void;
    const lost = new Promise<FakeGpuDeviceLostInfo>((resolve) => {
      resolveLost = resolve;
    });
    const events = new EventTarget();
    // `state` is filled right after `device` is built; methods only run later.
    let state!: DeviceState;
    const queue = makeQueue(() => state, queueLabel);
    const device: FakeGpuDevice = {
      fakeId,
      label,
      features,
      limits,
      adapterInfo,
      queue,
      lost,
      get isLost() {
        return state.lost;
      },
      onuncapturederror: null,
      createBuffer(descriptor) {
        record(fakeId, 'createBuffer', [descriptor]);
        if (descriptor.size > limits.maxBufferSize) {
          raise(state, new FakeGpuOutOfMemoryError(`Buffer size ${descriptor.size} exceeds maxBufferSize ${limits.maxBufferSize}.`));
        }
        return makeBuffer(state, descriptor);
      },
      createTexture(descriptor) {
        record(fakeId, 'createTexture', [descriptor]);
        const [w, h, d] = extent(descriptor.size);
        if (w > limits.maxTextureDimension2D || h > limits.maxTextureDimension2D) {
          invalid(state, `Texture size ${w}×${h} exceeds maxTextureDimension2D ${limits.maxTextureDimension2D}.`);
        }
        return makeTexture({ ...descriptor, width: w, height: h, depthOrArrayLayers: d });
      },
      createSampler(descriptor = {}) {
        record(fakeId, 'createSampler', [descriptor]);
        return { fakeId: nextId('sampler'), label: descriptor.label ?? '' };
      },
      createShaderModule(descriptor) {
        record(fakeId, 'createShaderModule', [descriptor]);
        const messages = options.compile?.(descriptor.code) ?? [];
        const firstError = messages.find((m) => m.type === 'error');
        if (firstError !== undefined) invalid(state, `Shader compilation failed: ${firstError.message}`);
        return {
          fakeId: nextId('shader'),
          label: descriptor.label ?? '',
          code: descriptor.code,
          getCompilationInfo: () => Promise.resolve({ messages }),
        };
      },
      createBindGroupLayout(descriptor) {
        record(fakeId, 'createBindGroupLayout', [descriptor]);
        return { fakeId: nextId('bind-group-layout'), label: descriptor.label ?? '' };
      },
      createPipelineLayout(descriptor) {
        record(fakeId, 'createPipelineLayout', [descriptor]);
        return { fakeId: nextId('pipeline-layout'), label: descriptor.label ?? '' };
      },
      createBindGroup(descriptor) {
        record(fakeId, 'createBindGroup', [descriptor]);
        return { fakeId: nextId('bind-group'), label: descriptor.label ?? '' };
      },
      createRenderPipeline(descriptor) {
        record(fakeId, 'createRenderPipeline', [descriptor]);
        return makePipeline('render-pipeline', descriptor);
      },
      createComputePipeline(descriptor) {
        record(fakeId, 'createComputePipeline', [descriptor]);
        return makePipeline('compute-pipeline', descriptor);
      },
      createRenderPipelineAsync(descriptor) {
        record(fakeId, 'createRenderPipelineAsync', [descriptor]);
        return Promise.resolve(makePipeline('render-pipeline', descriptor));
      },
      createComputePipelineAsync(descriptor) {
        record(fakeId, 'createComputePipelineAsync', [descriptor]);
        return Promise.resolve(makePipeline('compute-pipeline', descriptor));
      },
      createCommandEncoder(descriptor = {}) {
        record(fakeId, 'createCommandEncoder', [descriptor]);
        return makeEncoder(state, descriptor.label ?? '');
      },
      createQuerySet(descriptor) {
        record(fakeId, 'createQuerySet', [descriptor]);
        return { fakeId: nextId('query-set'), label: descriptor.label ?? '' };
      },
      pushErrorScope(filter) {
        record(fakeId, 'pushErrorScope', [filter]);
        state.scopes.push({ filter, error: null });
      },
      popErrorScope() {
        record(fakeId, 'popErrorScope', []);
        if (state.lost) return Promise.resolve(null);
        const scope = state.scopes.pop();
        if (scope === undefined) return Promise.reject(new DOMException('popErrorScope called with an empty error scope stack.', 'OperationError'));
        return Promise.resolve(scope.error);
      },
      destroy() {
        record(fakeId, 'destroy', []);
        lose(state, 'destroyed', 'Device was destroyed.');
      },
      addEventListener(type, listener, listenerOptions) {
        // sf-lint-disable-next-line no-bare-listener -- this IS GPUDevice.addEventListener; the caller owns the listener and its options
        events.addEventListener(type, listener as EventListener, listenerOptions);
      },
      removeEventListener(type, listener) {
        events.removeEventListener(type, listener as EventListener);
      },
    };
    state = { device, lost: false, resolveLost, scopes: [], events, pendingMaps: new Set() };
    deviceStates.set(device, state);
    devices.push(device);
    return device;
  };

  const makePipeline = (kind: string, descriptor: { readonly label?: string }): FakeGpuPipeline => {
    const fakeId = nextId(kind);
    return {
      fakeId,
      label: descriptor.label ?? '',
      descriptor,
      getBindGroupLayout(index) {
        record(fakeId, 'getBindGroupLayout', [index]);
        return { fakeId: nextId('bind-group-layout'), label: '' };
      },
    };
  };

  const makeBuffer = (state: DeviceState, descriptor: { readonly label?: string; readonly size: number; readonly usage: number; readonly mappedAtCreation?: boolean }): FakeGpuBuffer => {
    const fakeId = nextId('buffer');
    const bytes = new Uint8Array(Math.max(0, Math.min(descriptor.size, 1 << 28)));
    let mapState: FakeGpuBuffer['mapState'] = descriptor.mappedAtCreation === true ? 'mapped' : 'unmapped';
    let destroyed = false;
    let mappedRange: ArrayBuffer | undefined;
    let mappedOffset = 0;
    let pendingMap: { reject: (e: unknown) => void } | undefined;
    const buffer: FakeGpuBuffer = {
      fakeId,
      label: descriptor.label ?? '',
      size: descriptor.size,
      usage: descriptor.usage,
      contents: bytes,
      get mapState() {
        return mapState;
      },
      get destroyed() {
        return destroyed;
      },
      mapAsync(mode, offset = 0, size) {
        record(fakeId, 'mapAsync', [mode, offset, size]);
        const length = size ?? descriptor.size - offset;
        const needed = mode & MapMode.READ ? BufferUsage.MAP_READ : BufferUsage.MAP_WRITE;
        if (state.lost) return Promise.reject(new DOMException('Device is lost.', 'OperationError'));
        if (destroyed || mapState !== 'unmapped' || (descriptor.usage & needed) === 0 || offset + length > descriptor.size || offset % 8 !== 0 || length % 4 !== 0) {
          invalid(
            state,
            destroyed
              ? `mapAsync on destroyed buffer ${fakeId}.`
              : mapState !== 'unmapped'
                ? `mapAsync on ${fakeId} while it is ${mapState}.`
                : (descriptor.usage & needed) === 0
                  ? `mapAsync on ${fakeId} without ${mode & MapMode.READ ? 'MAP_READ' : 'MAP_WRITE'} usage.`
                  : `mapAsync range ${offset}+${length} is invalid for ${fakeId} (size ${descriptor.size}).`,
          );
          return Promise.reject(new DOMException('mapAsync validation failed.', 'OperationError'));
        }
        mapState = 'pending';
        return new Promise<undefined>((resolve, reject) => {
          const pending = {
            reject: (e: unknown): void => {
              mapState = 'unmapped';
              pendingMap = undefined;
              reject(e);
            },
          };
          pendingMap = pending;
          state.pendingMaps.add(pending);
          enqueue(() => {
            if (!state.pendingMaps.delete(pending)) return;
            pendingMap = undefined;
            if (destroyed || mapState !== 'pending') {
              reject(new DOMException('Buffer was unmapped or destroyed before the map completed.', 'AbortError'));
              return;
            }
            mapState = 'mapped';
            mappedOffset = offset;
            mappedRange = bytes.slice(offset, offset + length).buffer;
            resolve(undefined);
          });
        });
      },
      getMappedRange(offset, size) {
        record(fakeId, 'getMappedRange', [offset, size]);
        if (mapState !== 'mapped') throw new DOMException(`getMappedRange on ${fakeId} while it is ${mapState}.`, 'OperationError');
        if (mappedRange === undefined) {
          // mappedAtCreation: the whole buffer
          mappedOffset = 0;
          mappedRange = bytes.slice().buffer;
        }
        const start = (offset ?? mappedOffset) - mappedOffset;
        const end = size === undefined ? mappedRange.byteLength : start + size;
        return mappedRange.slice(start, end);
      },
      unmap() {
        record(fakeId, 'unmap', []);
        if (pendingMap !== undefined) {
          state.pendingMaps.delete(pendingMap);
          pendingMap.reject(new DOMException('Buffer was unmapped before the map completed.', 'AbortError'));
        }
        mapState = 'unmapped';
        mappedRange = undefined;
      },
      destroy() {
        record(fakeId, 'destroy', []);
        if (mapState === 'pending') buffer.unmap();
        destroyed = true;
        mapState = 'unmapped';
      },
    };
    return buffer;
  };

  const makeTexture = (
    descriptor: { readonly label?: string; readonly width: number; readonly height: number; readonly depthOrArrayLayers: number; readonly format: string; readonly usage: number; readonly mipLevelCount?: number; readonly sampleCount?: number; readonly dimension?: string },
    kind = 'texture',
  ): FakeGpuTexture => {
    const fakeId = nextId(kind);
    const mipLevelCount = descriptor.mipLevelCount ?? 1;
    const sampleCount = descriptor.sampleCount ?? 1;
    const dimension = descriptor.dimension ?? '2d';
    const stored = STORED_FORMATS.has(descriptor.format) && dimension === '2d' && mipLevelCount === 1 && sampleCount === 1 && descriptor.depthOrArrayLayers === 1;
    const contents = stored ? new Uint8Array(descriptor.width * descriptor.height * 4) : undefined;
    let destroyed = false;
    const texture: FakeGpuTexture = {
      fakeId,
      label: descriptor.label ?? '',
      width: descriptor.width,
      height: descriptor.height,
      depthOrArrayLayers: descriptor.depthOrArrayLayers,
      mipLevelCount,
      sampleCount,
      dimension,
      format: descriptor.format,
      usage: descriptor.usage,
      contents,
      get destroyed() {
        return destroyed;
      },
      createView(viewDescriptor = {}) {
        record(fakeId, 'createView', [viewDescriptor]);
        return { fakeId: nextId('texture-view'), label: viewDescriptor.label ?? '', texture };
      },
      destroy() {
        record(fakeId, 'destroy', []);
        destroyed = true;
      },
    };
    return texture;
  };

  const recorder = <T extends object>(fakeId: string, names: readonly string[], extra: T): T => {
    const out: Record<string, unknown> = { ...(extra as Record<string, unknown>) };
    for (const name of names) {
      out[name] = (...args: unknown[]): void => record(fakeId, name, args);
    }
    return out as T;
  };

  const makeEncoder = (state: DeviceState, label: string): FakeGpuCommandEncoder => {
    const fakeId = nextId('encoder');
    const ops: Op[] = [];
    const resources = new Set<FakeGpuBuffer | FakeGpuTexture>();
    let valid = true;
    let openPass = false;
    let finished = false;
    const fail = (message: string): void => {
      valid = false;
      invalid(state, message);
    };
    const checkOpen = (method: string): boolean => {
      if (finished) {
        fail(`${method} on ${fakeId} after finish().`);
        return false;
      }
      if (openPass) {
        fail(`${method} on ${fakeId} while a pass is open.`);
        return false;
      }
      return true;
    };
    const checkTexelCopy = (texture: FakeGpuTexture, layout: TexelCopyBuffer, size: GpuExtent, direction: 'from-texture' | 'to-texture'): boolean => {
      const [w, h] = extent(size);
      const bytesPerRow = layout.bytesPerRow ?? w * 4;
      const offset = layout.offset ?? 0;
      if (layout.bytesPerRow !== undefined && layout.bytesPerRow % 256 !== 0) {
        fail(`bytesPerRow (${layout.bytesPerRow}) must be a multiple of 256 for texture↔buffer copies in a command encoder.`);
        return false;
      }
      if (layout.bytesPerRow === undefined && h > 1) {
        fail('bytesPerRow is required when copying more than one row.');
        return false;
      }
      const textureUsage = direction === 'from-texture' ? TextureUsage.COPY_SRC : TextureUsage.COPY_DST;
      if ((texture.usage & textureUsage) === 0) {
        fail(`${texture.fakeId} lacks ${direction === 'from-texture' ? 'COPY_SRC' : 'COPY_DST'} usage.`);
        return false;
      }
      const bufferUsage = direction === 'from-texture' ? BufferUsage.COPY_DST : BufferUsage.COPY_SRC;
      if ((layout.buffer.usage & bufferUsage) === 0) {
        fail(`${layout.buffer.fakeId} lacks ${direction === 'from-texture' ? 'COPY_DST' : 'COPY_SRC'} usage.`);
        return false;
      }
      if (h > 0 && offset + bytesPerRow * (h - 1) + w * 4 > layout.buffer.size) {
        fail(`Copy of ${w}×${h} texels with bytesPerRow ${bytesPerRow} overruns ${layout.buffer.fakeId} (size ${layout.buffer.size}).`);
        return false;
      }
      if (texture.sampleCount !== 1) {
        fail(`${texture.fakeId} is multisampled and cannot be copied.`);
        return false;
      }
      return true;
    };
    const encoder: FakeGpuCommandEncoder = {
      fakeId,
      label,
      beginRenderPass(descriptor) {
        record(fakeId, 'beginRenderPass', [descriptor]);
        const passId = nextId('render-pass');
        if (checkOpen('beginRenderPass')) {
          for (const attachment of descriptor.colorAttachments) {
            if (attachment === null) continue;
            const texture = attachment.view.texture;
            resources.add(texture);
            if ((texture.usage & TextureUsage.RENDER_ATTACHMENT) === 0) fail(`${texture.fakeId} lacks RENDER_ATTACHMENT usage.`);
            if (attachment.loadOp === 'clear') ops.push(() => clearTexture(texture, attachment.clearValue));
          }
        }
        openPass = true;
        return recorder<FakeGpuRenderPass>(
          passId,
          ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'setViewport', 'setScissorRect', 'setBlendConstant', 'setStencilReference', 'draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect', 'executeBundles', 'pushDebugGroup', 'popDebugGroup', 'insertDebugMarker'],
          {
            fakeId: passId,
            label: descriptor.label ?? '',
            end() {
              record(passId, 'end', []);
              openPass = false;
            },
          } as FakeGpuRenderPass,
        );
      },
      beginComputePass(descriptor = {}) {
        record(fakeId, 'beginComputePass', [descriptor]);
        const passId = nextId('compute-pass');
        checkOpen('beginComputePass');
        openPass = true;
        return recorder<FakeGpuComputePass>(passId, ['setPipeline', 'setBindGroup', 'dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'pushDebugGroup', 'popDebugGroup', 'insertDebugMarker'], {
          fakeId: passId,
          label: descriptor.label ?? '',
          end() {
            record(passId, 'end', []);
            openPass = false;
          },
        } as FakeGpuComputePass);
      },
      copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
        record(fakeId, 'copyBufferToBuffer', [source, sourceOffset, destination, destinationOffset, size]);
        if (!checkOpen('copyBufferToBuffer')) return;
        if ((source.usage & BufferUsage.COPY_SRC) === 0) return fail(`${source.fakeId} lacks COPY_SRC usage.`);
        if ((destination.usage & BufferUsage.COPY_DST) === 0) return fail(`${destination.fakeId} lacks COPY_DST usage.`);
        if (size % 4 !== 0 || sourceOffset % 4 !== 0 || destinationOffset % 4 !== 0) return fail('copyBufferToBuffer offsets and size must be multiples of 4.');
        if (sourceOffset + size > source.size || destinationOffset + size > destination.size) return fail('copyBufferToBuffer is out of bounds.');
        resources.add(source).add(destination);
        ops.push(() => destination.contents.set(source.contents.subarray(sourceOffset, sourceOffset + size), destinationOffset));
      },
      copyBufferToTexture(source, destination, size) {
        record(fakeId, 'copyBufferToTexture', [source, destination, size]);
        if (!checkOpen('copyBufferToTexture') || !checkTexelCopy(destination.texture, source, size, 'to-texture')) return;
        resources.add(source.buffer).add(destination.texture);
        ops.push(() => copyRows(source.buffer.contents, source.offset ?? 0, source.bytesPerRow ?? extent(size)[0] * 4, destination.texture, destination.origin, size, 'to-texture'));
      },
      copyTextureToBuffer(source, destination, size) {
        record(fakeId, 'copyTextureToBuffer', [source, destination, size]);
        if (!checkOpen('copyTextureToBuffer') || !checkTexelCopy(source.texture, destination, size, 'from-texture')) return;
        resources.add(source.texture).add(destination.buffer);
        ops.push(() => copyRows(destination.buffer.contents, destination.offset ?? 0, destination.bytesPerRow ?? extent(size)[0] * 4, source.texture, source.origin, size, 'from-texture'));
      },
      copyTextureToTexture(source, destination, size) {
        record(fakeId, 'copyTextureToTexture', [source, destination, size]);
        if (!checkOpen('copyTextureToTexture')) return;
        if ((source.texture.usage & TextureUsage.COPY_SRC) === 0) return fail(`${source.texture.fakeId} lacks COPY_SRC usage.`);
        if ((destination.texture.usage & TextureUsage.COPY_DST) === 0) return fail(`${destination.texture.fakeId} lacks COPY_DST usage.`);
        resources.add(source.texture).add(destination.texture);
        ops.push(() => {
          const [w, h] = extent(size);
          const scratch = new Uint8Array(w * h * 4);
          copyRows(scratch, 0, w * 4, source.texture, source.origin, size, 'from-texture');
          copyRows(scratch, 0, w * 4, destination.texture, destination.origin, size, 'to-texture');
        });
      },
      clearBuffer(buffer, offset = 0, size) {
        record(fakeId, 'clearBuffer', [buffer, offset, size]);
        if (!checkOpen('clearBuffer')) return;
        if ((buffer.usage & BufferUsage.COPY_DST) === 0) return fail(`${buffer.fakeId} lacks COPY_DST usage.`);
        resources.add(buffer);
        ops.push(() => buffer.contents.fill(0, offset, size === undefined ? undefined : offset + size));
      },
      resolveQuerySet(...args) {
        record(fakeId, 'resolveQuerySet', args);
      },
      pushDebugGroup(debugLabel) {
        record(fakeId, 'pushDebugGroup', [debugLabel]);
      },
      popDebugGroup() {
        record(fakeId, 'popDebugGroup', []);
      },
      insertDebugMarker(marker) {
        record(fakeId, 'insertDebugMarker', [marker]);
      },
      finish(descriptor = {}) {
        record(fakeId, 'finish', [descriptor]);
        if (openPass) fail(`finish() on ${fakeId} with a pass still open (call pass.end()).`);
        if (finished) fail(`finish() called twice on ${fakeId}.`);
        finished = true;
        const commandBuffer: FakeGpuCommandBuffer & { ops: readonly Op[]; resources: ReadonlySet<FakeGpuBuffer | FakeGpuTexture> } = {
          fakeId: nextId('command-buffer'),
          label: descriptor.label ?? '',
          valid,
          ops,
          resources,
        };
        return commandBuffer;
      },
    };
    return encoder;
  };

  const makeQueue = (stateOf: () => DeviceState, queueLabel: string): FakeGpuQueue => {
    const fakeId = nextId('queue');
    return {
      fakeId,
      label: queueLabel,
      submit(commandBuffers) {
        record(fakeId, 'submit', [commandBuffers]);
        const state = stateOf();
        if (state.lost) return;
        for (const cb of commandBuffers as readonly (FakeGpuCommandBuffer & { ops?: readonly Op[]; resources?: ReadonlySet<FakeGpuBuffer | FakeGpuTexture>; submitted?: boolean })[]) {
          if (!cb.valid) return invalid(state, `submit: ${cb.fakeId} is invalid (an encoder command failed validation).`);
          if (cb.submitted === true) return invalid(state, `submit: ${cb.fakeId} was already submitted.`);
          for (const resource of cb.resources ?? []) {
            if (resource.destroyed) return invalid(state, `submit: ${resource.fakeId} is destroyed${resource.fakeId.startsWith('canvas-texture') ? ' (canvas textures expire when the frame is presented)' : ''}.`);
            if ('mapState' in resource && resource.mapState !== 'unmapped') return invalid(state, `submit: ${resource.fakeId} is ${resource.mapState}; unmap it first.`);
          }
        }
        for (const cb of commandBuffers as readonly (FakeGpuCommandBuffer & { ops?: readonly Op[]; submitted?: boolean })[]) {
          for (const op of cb.ops ?? []) op();
          (cb as { submitted?: boolean }).submitted = true;
        }
      },
      writeBuffer(buffer, bufferOffset, data, dataOffset = 0, size) {
        record(fakeId, 'writeBuffer', [buffer, bufferOffset, data, dataOffset, size]);
        const state = stateOf();
        if (state.lost) return;
        const elementSize = ArrayBuffer.isView(data) ? ((data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1) : 1;
        const source = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const start = dataOffset * elementSize;
        const length = size === undefined ? source.length - start : size * elementSize;
        if ((buffer.usage & BufferUsage.COPY_DST) === 0) return invalid(state, `writeBuffer: ${buffer.fakeId} lacks COPY_DST usage.`);
        if (bufferOffset + length > buffer.size || length % 4 !== 0) return invalid(state, `writeBuffer: ${length} bytes at ${bufferOffset} is invalid for ${buffer.fakeId} (size ${buffer.size}).`);
        buffer.contents.set(source.subarray(start, start + length), bufferOffset);
      },
      writeTexture(destination, data, dataLayout, size) {
        record(fakeId, 'writeTexture', [destination, data, dataLayout, size]);
        const state = stateOf();
        if (state.lost) return;
        if ((destination.texture.usage & TextureUsage.COPY_DST) === 0) return invalid(state, `writeTexture: ${destination.texture.fakeId} lacks COPY_DST usage.`);
        const source = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        copyRows(source, dataLayout.offset ?? 0, dataLayout.bytesPerRow ?? extent(size)[0] * 4, destination.texture, destination.origin, size, 'to-texture');
      },
      copyExternalImageToTexture(...args) {
        record(fakeId, 'copyExternalImageToTexture', args);
      },
      onSubmittedWorkDone() {
        record(fakeId, 'onSubmittedWorkDone', []);
        return new Promise<undefined>((resolve) => enqueue(() => resolve(undefined)));
      },
    };
  };

  const createCanvas = (size: { readonly width?: number; readonly height?: number } = {}): FakeCanvasHandle => {
    const contextId = nextId('context');
    let configuration: FakeCanvasConfiguration | null = null;
    let current: FakeGpuTexture | undefined;
    let lastPresented: FakeGpuTexture | undefined;
    let presentedFrames = 0;
    const canvas: FakeGpuCanvas = {
      width: size.width ?? 300,
      height: size.height ?? 150,
      getContext(id) {
        return id === 'webgpu' ? context : null;
      },
    };
    const context: FakeGpuCanvasContext = {
      canvas,
      configure(config) {
        record(contextId, 'configure', [config]);
        configuration = config;
        current = undefined;
      },
      unconfigure() {
        record(contextId, 'unconfigure', []);
        configuration = null;
        current?.destroy();
        current = undefined;
      },
      getConfiguration() {
        return configuration;
      },
      getCurrentTexture() {
        record(contextId, 'getCurrentTexture', []);
        if (configuration === null) throw new DOMException('getCurrentTexture() before configure().', 'InvalidStateError');
        if (current === undefined) {
          const state = deviceStates.get(configuration.device);
          if (state === undefined) throw new TypeError('configure() was given a device that this fake did not create.');
          current = makeTexture(
            { label: '', width: canvas.width, height: canvas.height, depthOrArrayLayers: 1, format: configuration.format, usage: configuration.usage ?? TextureUsage.RENDER_ATTACHMENT },
            'canvas-texture',
          );
        }
        return current;
      },
    };
    return {
      canvas,
      context,
      present() {
        record(contextId, 'present', []);
        if (current === undefined) return undefined;
        const presented = current;
        presented.destroy();
        lastPresented = presented;
        presentedFrames++;
        current = undefined;
        return presented;
      },
      get presentedFrames() {
        return presentedFrames;
      },
      get lastPresented() {
        return lastPresented;
      },
    };
  };

  const gpu: FakeGpuEntry = {
    requestAdapter(adapterRequest = {}) {
      record('gpu', 'requestAdapter', [adapterRequest]);
      return Promise.resolve(adapterOptions === false ? null : makeAdapter(adapterOptions));
    },
    getPreferredCanvasFormat() {
      return options.preferredCanvasFormat ?? 'bgra8unorm';
    },
    wgslLanguageFeatures: new Set(options.wgslLanguageFeatures ?? []),
  };

  return {
    gpu,
    calls,
    callsTo(method, kind) {
      return calls.filter((c) => c.method === method && (kind === undefined || c.target.startsWith(`${kind}#`) || c.target === kind));
    },
    clearCalls() {
      calls.length = 0;
    },
    adapters,
    devices,
    uncapturedErrors,
    setAdapter(next) {
      adapterOptions = next;
    },
    failNextRequestDevice(error = new DOMException('requestDevice failed (injected).', 'OperationError')) {
      nextRequestDeviceFailure = { error };
    },
    loseDevice(device = devices[devices.length - 1], reason = 'unknown', message = 'Device lost (injected).') {
      if (device === undefined) throw new TypeError('loseDevice: no device has been created yet.');
      const state = deviceStates.get(device);
      if (state === undefined) throw new TypeError('loseDevice: the device was not created by this fake.');
      record(device.fakeId, 'lose', [reason, message]);
      lose(state, reason, message);
    },
    injectError(device, error) {
      const state = deviceStates.get(device);
      if (state === undefined) throw new TypeError('injectError: the device was not created by this fake.');
      raise(state, error);
    },
    createCanvas,
    flushQueue,
    globals: {
      GPUBufferUsage: GPU_CONSTANTS.BufferUsage,
      GPUTextureUsage: GPU_CONSTANTS.TextureUsage,
      GPUMapMode: GPU_CONSTANTS.MapMode,
      GPUShaderStage: GPU_CONSTANTS.ShaderStage,
      GPUColorWrite: GPU_CONSTANTS.ColorWrite,
      GPUValidationError: FakeGpuValidationError,
      GPUOutOfMemoryError: FakeGpuOutOfMemoryError,
      GPUInternalError: FakeGpuInternalError,
    },
  };
}

function extent(size: GpuExtent): [number, number, number] {
  if (Array.isArray(size)) return [size[0] ?? 1, size[1] ?? 1, size[2] ?? 1];
  const dict = size as { readonly width: number; readonly height?: number; readonly depthOrArrayLayers?: number };
  return [dict.width, dict.height ?? 1, dict.depthOrArrayLayers ?? 1];
}

function origin(value: GpuOrigin | undefined): [number, number] {
  if (value === undefined) return [0, 0];
  if (Array.isArray(value)) return [value[0] ?? 0, value[1] ?? 0];
  const dict = value as { readonly x?: number; readonly y?: number };
  return [dict.x ?? 0, dict.y ?? 0];
}

/** Copy rows between a linear byte array (`bytesPerRow` stride) and a stored texture region. */
function copyRows(linear: Uint8Array, offset: number, bytesPerRow: number, texture: FakeGpuTexture, at: GpuOrigin | undefined, size: GpuExtent, direction: 'from-texture' | 'to-texture'): void {
  const contents = texture.contents;
  if (contents === undefined) return;
  const [w, h] = extent(size);
  const [ox, oy] = origin(at);
  for (let y = 0; y < h; y++) {
    const textureStart = ((oy + y) * texture.width + ox) * 4;
    const linearStart = offset + y * bytesPerRow;
    if (direction === 'from-texture') linear.set(contents.subarray(textureStart, textureStart + w * 4), linearStart);
    else contents.set(linear.subarray(linearStart, linearStart + w * 4), textureStart);
  }
}

function clearTexture(texture: FakeGpuTexture, clearValue: unknown): void {
  const contents = texture.contents;
  if (contents === undefined || !CLEARABLE_FORMATS.has(texture.format)) return;
  const [r, g, b, a] = color(clearValue);
  const srgb = texture.format.endsWith('-srgb');
  const encode = (c: number): number => Math.round(clamp01(srgb ? linearToSrgb(clamp01(c)) : c) * 255);
  const px = texture.format.startsWith('bgra') ? [encode(b), encode(g), encode(r), Math.round(clamp01(a) * 255)] : [encode(r), encode(g), encode(b), Math.round(clamp01(a) * 255)];
  for (let i = 0; i < contents.length; i += 4) contents.set(px, i);
}

function color(value: unknown): [number, number, number, number] {
  if (value === undefined || value === null) return [0, 0, 0, 0];
  if (Array.isArray(value)) return [Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0), Number(value[3] ?? 0)];
  const dict = value as { r?: number; g?: number; b?: number; a?: number };
  return [dict.r ?? 0, dict.g ?? 0, dict.b ?? 0, dict.a ?? 0];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** IEC 61966-2-1 sRGB encoding. */
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}
