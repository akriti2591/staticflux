/**
 * Repeat parameters (IF-26.2–26.5): typed views of the `repeat.*` registers, their ranges, the instance count, and
 * the set ops that write them. Reading never fails: a value out of range is clamped (and reported by
 * `validateRepeatOps` on write, IF-REP-001); a node without a valid `repeat.kind` is not a repeat.
 *
 * Ranges (`REPEAT_LIMITS`): radial `count` 1…360, `radius` ≥ 0, `sweep` (0, 360]; grid `rows` and `columns` 1…100;
 * `brickShift` −1…1; at most `instances` (1,000) instances per repeat (IF-REP-002). Angles, gaps and offsets are any
 * finite number.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartOp } from '@staticflux/document/v2';
import { BRICK_AXES, type BrickAxis, MIRROR_AXES, type MirrorAxis, REPEAT_DEFAULTS, REPEAT_KIND_PARAMS, REPEAT_KINDS, REPEAT_PATHS, type RepeatKind, type RepeatParamName, RP } from './components.js';
import { InvalidRepeatParamError, TooManyInstancesError } from './errors.js';

export interface RadialParams {
  readonly kind: 'radial';
  readonly count: number;
  readonly radius: number;
  readonly startAngle: number;
  readonly sweep: number;
  readonly rotate: boolean;
}

export interface GridParams {
  readonly kind: 'grid';
  readonly rows: number;
  readonly columns: number;
  readonly gapX: number;
  readonly gapY: number;
  readonly rowOffset: number;
  readonly columnOffset: number;
  readonly brick: BrickAxis;
  readonly brickShift: number;
}

export interface MirrorParams {
  readonly kind: 'mirror';
  readonly axis: MirrorAxis;
  readonly angle: number;
  readonly offset: number;
}

export type RepeatParams = RadialParams | GridParams | MirrorParams;
/** A partial edit of the parameters (any generator's names; `kind` switches the generator). */
export type RepeatPatch = { readonly kind?: RepeatKind | undefined } & { readonly [K in RepeatParamName]?: number | boolean | string | undefined };

export const REPEAT_LIMITS = { count: { min: 1, max: 360 }, rows: { min: 1, max: 100 }, columns: { min: 1, max: 100 }, sweep: { min: 0, max: 360 }, brickShift: { min: -1, max: 1 }, instances: 1000 } as const;

interface ParamCheck {
  readonly expects: string;
  readonly ok: (v: JsonValue) => boolean;
}

const finite = (v: JsonValue): v is number => typeof v === 'number' && Number.isFinite(v);
const intIn = (min: number, max: number): ParamCheck => ({ expects: `an integer ${min}…${max}`, ok: (v) => finite(v) && Number.isInteger(v) && v >= min && v <= max });
const anyNumber: ParamCheck = { expects: 'a finite number', ok: finite };
const oneOf = (values: readonly string[]): ParamCheck => ({ expects: `one of ${values.join(', ')}`, ok: (v) => typeof v === 'string' && values.includes(v) });

const CHECKS: Readonly<Record<string, ParamCheck>> = {
  [RP.kind]: oneOf(REPEAT_KINDS),
  [RP.count]: intIn(REPEAT_LIMITS.count.min, REPEAT_LIMITS.count.max),
  [RP.radius]: { expects: 'a number ≥ 0', ok: (v) => finite(v) && v >= 0 },
  [RP.startAngle]: anyNumber,
  [RP.sweep]: { expects: 'degrees in (0, 360]', ok: (v) => finite(v) && v > REPEAT_LIMITS.sweep.min && v <= REPEAT_LIMITS.sweep.max },
  [RP.rotate]: { expects: 'true or false', ok: (v) => typeof v === 'boolean' },
  [RP.rows]: intIn(REPEAT_LIMITS.rows.min, REPEAT_LIMITS.rows.max),
  [RP.columns]: intIn(REPEAT_LIMITS.columns.min, REPEAT_LIMITS.columns.max),
  [RP.gapX]: anyNumber,
  [RP.gapY]: anyNumber,
  [RP.rowOffset]: anyNumber,
  [RP.columnOffset]: anyNumber,
  [RP.brick]: oneOf(BRICK_AXES),
  [RP.brickShift]: { expects: 'a number −1…1', ok: (v) => finite(v) && v >= REPEAT_LIMITS.brickShift.min && v <= REPEAT_LIMITS.brickShift.max },
  [RP.axis]: oneOf(MIRROR_AXES),
  [RP.angle]: anyNumber,
  [RP.offset]: anyNumber,
};

/** Check one `repeat.*` value (null clears and is always fine; other paths are not ours). */
export function checkRepeatValue(path: string, value: JsonValue | null): Result<void> {
  const check = CHECKS[path];
  if (value === null || check === undefined || check.ok(value)) return ok();
  return err(InvalidRepeatParamError({ message: `"${path}" expects ${check.expects}.`, details: { path, expects: check.expects } }));
}

const num = (v: JsonValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const int = (v: JsonValue | undefined, fallback: number, range: { readonly min: number; readonly max: number }): number => clamp(Math.round(num(v, fallback)), range.min, range.max);
const pick = <T extends string>(v: JsonValue | undefined, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);

/** Readers per generator (composed values omit defaults). */
const READERS: { readonly [K in RepeatKind]: (values: Readonly<Record<string, JsonValue>>) => Extract<RepeatParams, { kind: K }> } = {
  radial: (v) => ({
    kind: 'radial',
    count: int(v[RP.count], REPEAT_DEFAULTS.count, REPEAT_LIMITS.count),
    radius: Math.max(0, num(v[RP.radius], REPEAT_DEFAULTS.radius)),
    startAngle: num(v[RP.startAngle], REPEAT_DEFAULTS.startAngle),
    sweep: num(v[RP.sweep], REPEAT_DEFAULTS.sweep) > 0 ? Math.min(REPEAT_LIMITS.sweep.max, num(v[RP.sweep], REPEAT_DEFAULTS.sweep)) : REPEAT_DEFAULTS.sweep,
    rotate: typeof v[RP.rotate] === 'boolean' ? (v[RP.rotate] as boolean) : REPEAT_DEFAULTS.rotate,
  }),
  grid: (v) => {
    const rows = int(v[RP.rows], REPEAT_DEFAULTS.rows, REPEAT_LIMITS.rows);
    // rows × columns never exceeds the instance limit (columns give way).
    const columns = Math.min(int(v[RP.columns], REPEAT_DEFAULTS.columns, REPEAT_LIMITS.columns), Math.max(1, Math.floor(REPEAT_LIMITS.instances / rows)));
    return {
      kind: 'grid',
      rows,
      columns,
      gapX: num(v[RP.gapX], REPEAT_DEFAULTS.gapX),
      gapY: num(v[RP.gapY], REPEAT_DEFAULTS.gapY),
      rowOffset: num(v[RP.rowOffset], REPEAT_DEFAULTS.rowOffset),
      columnOffset: num(v[RP.columnOffset], REPEAT_DEFAULTS.columnOffset),
      brick: pick(v[RP.brick], BRICK_AXES, REPEAT_DEFAULTS.brick),
      brickShift: clamp(num(v[RP.brickShift], REPEAT_DEFAULTS.brickShift), REPEAT_LIMITS.brickShift.min, REPEAT_LIMITS.brickShift.max),
    };
  },
  mirror: (v) => ({ kind: 'mirror', axis: pick(v[RP.axis], MIRROR_AXES, REPEAT_DEFAULTS.axis), angle: num(v[RP.angle], REPEAT_DEFAULTS.angle), offset: num(v[RP.offset], REPEAT_DEFAULTS.offset) }),
};

/** The repeat parameters of composed values, or undefined when the node is not a repeat. */
export function readRepeat(values: Readonly<Record<string, JsonValue>>): RepeatParams | undefined {
  const kind = values[RP.kind];
  if (typeof kind !== 'string' || !(REPEAT_KINDS as readonly string[]).includes(kind)) return undefined;
  return READERS[kind as RepeatKind](values);
}

const COUNTS: { readonly [K in RepeatKind]: (p: Extract<RepeatParams, { kind: K }>) => number } = {
  radial: (p) => p.count,
  grid: (p) => p.rows * p.columns,
  mirror: () => 2,
};

/** How many instances the parameters make (the source included). */
export function instanceCount(params: RepeatParams): number {
  return (COUNTS[params.kind] as (p: RepeatParams) => number)(params);
}

/** Default parameters of a generator. */
export function defaultParams(kind: RepeatKind): RepeatParams {
  return READERS[kind]({});
}

/** Set ops that write `params` on `node` (every parameter of its generator, plus the kind). */
export function repeatOps(node: NodeId, params: RepeatParams): PartOp[] {
  const values = params as unknown as Readonly<Record<string, JsonValue>>;
  return [{ op: 'set', node, path: RP.kind, value: params.kind }, ...REPEAT_KIND_PARAMS[params.kind].map((name): PartOp => ({ op: 'set', node, path: RP[name], value: values[name] as JsonValue }))];
}

/** Set ops for a patch (only the named parameters). */
export function patchOps(node: NodeId, patch: RepeatPatch): PartOp[] {
  return Object.entries(patch)
    .filter(([name, value]) => value !== undefined && name in RP)
    .map(([name, value]): PartOp => ({ op: 'set', node, path: RP[name as keyof typeof RP], value: value as JsonValue }));
}

/** Ops that clear every repeat parameter (the group becomes a plain group). */
export function clearRepeatOps(node: NodeId): PartOp[] {
  return REPEAT_PATHS.map((path): PartOp => ({ op: 'set', node, path, value: null }));
}

/** Apply a patch to parameters (a `kind` in the patch switches the generator; values are read with the clamps). */
export function applyPatch(params: RepeatParams, patch: RepeatPatch): RepeatParams {
  const values: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(params)) values[RP[name as keyof typeof RP]] = value as JsonValue;
  for (const [name, value] of Object.entries(patch)) if (value !== undefined && name in RP) values[RP[name as keyof typeof RP]] = value as JsonValue;
  return readRepeat(values) ?? params;
}

/**
 * Check the repeat values of a batch of ops (IF-REP-001) and the instance count of every repeat they set completely
 * enough to tell (IF-REP-002: radial `count`, grid `rows` × `columns` written together or against `current`).
 */
export function validateRepeatOps(ops: readonly PartOp[], current: (node: NodeId) => RepeatParams | undefined = () => undefined): Result<void> {
  const touched = new Map<NodeId, Record<string, JsonValue>>();
  for (const op of ops) {
    const entries: [string, JsonValue | null][] = op.op === 'set' ? [[op.path, op.value]] : op.op === 'create' ? Object.entries(op.props ?? {}) : [];
    for (const [path, value] of entries) {
      const r = checkRepeatValue(path, value);
      if (!r.ok) return r;
      if (CHECKS[path] !== undefined && value !== null) {
        let values = touched.get(op.node);
        if (values === undefined) touched.set(op.node, (values = {}));
        values[path] = value;
      }
    }
  }
  for (const [node, values] of touched) {
    const before = current(node);
    const base: Record<string, JsonValue> = {};
    if (before !== undefined) for (const [name, value] of Object.entries(before)) base[RP[name as keyof typeof RP]] = value as JsonValue;
    const merged = { ...base, ...values };
    const rows = merged[RP.rows];
    const columns = merged[RP.columns];
    const kind = merged[RP.kind];
    if (kind === 'grid' && finite(rows ?? null) && finite(columns ?? null) && (rows as number) * (columns as number) > REPEAT_LIMITS.instances) {
      return err(
        TooManyInstancesError({ message: `${String(rows)} × ${String(columns)} instances exceed ${REPEAT_LIMITS.instances}.`, details: { node, rows, columns, limit: REPEAT_LIMITS.instances } }),
      );
    }
  }
  return ok();
}
