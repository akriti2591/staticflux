/**
 * Brand kits (IF-4.6, IF-14.3, IF-20.5–20.8): tokens referenced as `@name`, style classes elements inherit
 * (`style.inherit`), final paths, and brand rules that the write path enforces.
 *
 * A brand kit is a `brand-kit` tree asset. Its root node (`kit`, kind `composition`) carries `brand.tokens.<name>`
 * (one LWW register per token: a CSS colour, a number, a font object, or another `@token` as an alias) and
 * `brand.rules`. Its `class` children are style classes: their node id is the class id, their `style.*` (and other)
 * values are what inheriting elements show unless they hold a local opinion, and `policy.final` lists paths that
 * inheriting elements cannot override (SF-STAGE-003 ↔ IF-CS-013).
 *
 * Composition goes through `@staticflux/stage`: `elementStageRules(kit)` adds the token rule, so a top-level
 * `@name` value resolves with provenance (`explain()` names the token); `resolveTokens` resolves tokens nested in
 * paints and effects with the same kit.
 */
import { err, ok, type Result } from '@staticflux/core';
import type { JsonValue, NodeId, PartId, PartOp, PropertyPath } from '@staticflux/document/v2';
import { type Actor, type AssetRef, DEFAULT_STAGE_RULES, type Stage, type StageDocument, type StageRules, type TokenRule, type WriteGuard } from '@staticflux/stage';
import { BRAND_KIT_ROOT, CLASS_KIND, P, tokenPath } from './components.js';
import { BrandRuleError, UnknownTokenError } from './errors.js';
import { colorToRgba, tokenName } from './values.js';

/** `effect`: a named effect style (one effect object, or a list of them), e.g. `@shadow-md`. */
export type TokenType = 'color' | 'size' | 'font' | 'effect' | 'other';

export interface BrandRule {
  /** Stable id (shown in lints and errors). */
  readonly id: string;
  /** Which nodes the rule covers (all given conditions must hold). */
  readonly when: { readonly role?: string; readonly kind?: string };
  /** The governed property path, e.g. `text.font` or `style.fill`. */
  readonly path: PropertyPath;
  /** Allowed values (tokens like `@display` or literals). An absent value is allowed (it inherits). */
  readonly allow: readonly JsonValue[];
  /** `block` (default): writes that break it are rejected. `warn`: lints only. */
  readonly severity?: 'block' | 'warn';
  /** Human sentence, e.g. "Headlines use @display". */
  readonly message?: string;
}

export interface BrandClassSpec {
  readonly name?: string;
  readonly props: Readonly<Record<PropertyPath, JsonValue>>;
  /** Paths inheriting elements may not override. */
  readonly final?: readonly string[];
}

export interface BrandKitSpec {
  readonly tokens: Readonly<Record<string, JsonValue>>;
  readonly classes?: Readonly<Record<string, BrandClassSpec>>;
  readonly rules?: readonly BrandRule[];
}

/** Part ops that build a brand kit (root `kit` plus one `class` node per class). */
export function brandKitOps(spec: BrandKitSpec): PartOp[] {
  const props: Record<PropertyPath, JsonValue> = {};
  for (const [name, value] of Object.entries(spec.tokens)) props[tokenPath(name)] = value;
  if (spec.rules !== undefined) props[P.rules] = spec.rules as unknown as JsonValue;
  const ops: PartOp[] = [{ op: 'create', node: BRAND_KIT_ROOT, kind: 'composition', parent: null, props: { name: 'Brand kit', ...props } }];
  for (const [id, cls] of Object.entries(spec.classes ?? {})) {
    ops.push({
      op: 'create',
      node: id,
      kind: CLASS_KIND,
      parent: BRAND_KIT_ROOT,
      props: { name: cls.name ?? id, ...cls.props, ...(cls.final === undefined ? {} : { [P.final]: [...cls.final] }) },
    });
  }
  return ops;
}

/** Stage token rule: `"@name"` → the kit root's `brand.tokens.name`. */
export function brandTokenRule(kit: AssetRef): TokenRule {
  return {
    match(value) {
      const name = tokenName(value);
      return name === undefined ? undefined : { ref: kit, node: BRAND_KIT_ROOT, path: tokenPath(name) };
    },
  };
}

/** Stage rules for element documents: the token rule for `kit`, and element-only paths kept out of inheritance. */
export function elementStageRules(kit?: AssetRef): Partial<StageRules> {
  return {
    notInherited: [...DEFAULT_STAGE_RULES.notInherited, 'lineage.', 'mask.', 'layout.', 'brand.'],
    // B10a's skew is part of the position: position locks cover it like rotation and flips.
    positionPaths: [...DEFAULT_STAGE_RULES.positionPaths, P.skewX],
    ...(kit === undefined ? {} : { token: brandTokenRule(kit) }),
  };
}

/** A token's type from its value. */
export function tokenType(value: JsonValue | undefined): TokenType {
  if (typeof value === 'number') return 'size';
  if (typeof value === 'string') return colorToRgba(value) !== undefined ? 'color' : 'other';
  const isEffect = (v: JsonValue): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Record<string, JsonValue>)['kind'] === 'string';
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Record<string, JsonValue>)['family'] === 'string') return 'font';
  if (value !== undefined && value !== null && (isEffect(value) || (Array.isArray(value) && value.length > 0 && value.every(isEffect)))) return 'effect';
  return 'other';
}

export interface BrandKitView {
  readonly key: string;
  /** Token names with their raw values (aliases unresolved). */
  tokens(): ReadonlyMap<string, JsonValue>;
  /** A token's value with aliases followed (undefined when missing or cyclic). */
  token(name: string): JsonValue | undefined;
  classes(): readonly { readonly id: NodeId; readonly name: string }[];
  rules(): readonly BrandRule[];
}

/** Read a brand kit document (per node; the kit is small). */
export function readBrandKit(doc: StageDocument): BrandKitView {
  const root = (): Readonly<Record<string, JsonValue>> => doc.node(BRAND_KIT_ROOT)?.props ?? {};
  const prefix = `${P.tokens}.`;
  const tokens = (): ReadonlyMap<string, JsonValue> => {
    const out = new Map<string, JsonValue>();
    for (const [path, value] of Object.entries(root())) if (path.startsWith(prefix)) out.set(path.slice(prefix.length), value);
    return out;
  };
  return {
    key: doc.key,
    tokens,
    token(name) {
      const all = tokens();
      const seen = new Set<string>();
      let current: string | undefined = name;
      while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        const value = all.get(current);
        if (value === undefined) return undefined;
        const alias = tokenName(value);
        if (alias === undefined) return value;
        current = alias;
      }
      return undefined;
    },
    classes() {
      return doc.children(BRAND_KIT_ROOT).flatMap((id) => {
        const node = doc.node(id);
        return node?.kind === CLASS_KIND ? [{ id, name: typeof node.props['name'] === 'string' ? (node.props['name'] as string) : id }] : [];
      });
    },
    rules() {
      const value = root()[P.rules];
      return Array.isArray(value) ? (value as unknown as BrandRule[]).filter((r) => typeof r === 'object' && r !== null && typeof r.path === 'string') : [];
    },
  };
}

/** Replace every `@token` string inside `value` (paints, effects) with its kit value; unknown tokens are listed. */
export function resolveTokens(value: JsonValue, lookup: (name: string) => JsonValue | undefined): { readonly value: JsonValue; readonly missing: readonly string[]; readonly used: readonly string[] } {
  const missing: string[] = [];
  const used: string[] = [];
  const walk = (v: JsonValue): JsonValue => {
    const name = tokenName(v);
    if (name !== undefined) {
      const resolved = lookup(name);
      if (resolved === undefined) {
        missing.push(name);
        return v;
      }
      used.push(name);
      return resolved;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), missing, used };
}

/** Check that a token exists and has the type a field needs. */
export function checkToken(kit: BrandKitView, ref: string, type: TokenType): Result<JsonValue> {
  const name = tokenName(ref);
  const value = name === undefined ? undefined : kit.token(name);
  if (value === undefined || tokenType(value) !== type) {
    return err(UnknownTokenError({ message: `No ${type} token "${ref}" in the brand kit.`, details: { token: ref, type } }));
  }
  return ok(value);
}

// ---------------------------------------------------------------- brand rules

export interface RuleContext {
  readonly kit: BrandKitView;
  /** Current composed value of a node path (the stage). */
  readonly value: (node: NodeId, path: PropertyPath) => JsonValue | undefined;
  readonly kind: (node: NodeId) => string | undefined;
}

export interface BrandViolation {
  readonly rule: BrandRule;
  readonly node: NodeId;
  readonly value: JsonValue | undefined;
}

function applies(rule: BrandRule, kind: string | undefined, role: JsonValue | undefined): boolean {
  return (rule.when.role === undefined || rule.when.role === role) && (rule.when.kind === undefined || rule.when.kind === kind);
}

function allowed(rule: BrandRule, value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  return rule.allow.some((a) => JSON.stringify(a) === JSON.stringify(value));
}

/** Violations a batch of ops would leave on the nodes it touches (state after the batch). */
export function brandViolations(ops: readonly PartOp[], ctx: RuleContext): BrandViolation[] {
  const rules = ctx.kit.rules();
  if (rules.length === 0) return [];
  const pending = new Map<NodeId, { kind: string | undefined; sets: Map<PropertyPath, JsonValue | null> }>();
  const touch = (node: NodeId, kind?: string): { kind: string | undefined; sets: Map<PropertyPath, JsonValue | null> } => {
    let entry = pending.get(node);
    if (entry === undefined) pending.set(node, (entry = { kind: kind ?? ctx.kind(node), sets: new Map() }));
    return entry;
  };
  for (const op of ops) {
    if (op.op === 'create') {
      const entry = touch(op.node, op.kind);
      for (const [path, value] of Object.entries(op.props ?? {})) entry.sets.set(path, value);
    } else if (op.op === 'set') {
      touch(op.node).sets.set(op.path, op.value);
    } else if (op.op === 'delete') {
      pending.delete(op.node);
    }
  }
  const out: BrandViolation[] = [];
  for (const [node, entry] of pending) {
    const after = (path: PropertyPath): JsonValue | undefined => {
      if (entry.sets.has(path)) return entry.sets.get(path) ?? undefined;
      return ctx.value(node, path);
    };
    for (const rule of rules) {
      if (!applies(rule, entry.kind, after('role'))) continue;
      if (!entry.sets.has(rule.path) && !entry.sets.has('role')) continue; // untouched: lint, not a write error
      const value = after(rule.path);
      if (!allowed(rule, value)) out.push({ rule, node, value });
    }
  }
  return out;
}

/** Reject writes that break a blocking brand rule (`IF-EL-003`). */
export function checkBrandRules(ops: readonly PartOp[], ctx: RuleContext): Result<void> {
  const blocking = brandViolations(ops, ctx).filter((v) => (v.rule.severity ?? 'block') === 'block');
  const first = blocking[0];
  if (first === undefined) return ok();
  return err(
    BrandRuleError({
      message: first.rule.message ?? `"${first.node}": ${first.rule.path} must be one of ${first.rule.allow.map((a) => JSON.stringify(a)).join(', ')}.`,
      details: { rule: first.rule.id, node: first.node, path: first.rule.path, allowed: first.rule.allow, value: first.value ?? null, violations: blocking.length },
    }),
  );
}

/** A write guard for the undo service: brand rules on every write (compose with `stageWriteGuard`). */
export function brandRuleGuard(ctx: () => RuleContext | undefined): WriteGuard {
  return (changes: Readonly<Record<PartId, readonly PartOp[]>>, _actor: Actor): Result<void> => {
    const current = ctx();
    if (current === undefined) return ok();
    for (const ops of Object.values(changes)) {
      const r = checkBrandRules(ops, current);
      if (!r.ok) return r;
    }
    return ok();
  };
}

/** Run several guards in order; the first failure wins. */
export function composeGuards(...guards: readonly WriteGuard[]): WriteGuard {
  return (changes, actor) => {
    for (const guard of guards) {
      const r = guard(changes, actor);
      if (!r.ok) return r;
    }
    return ok();
  };
}

/** Brand-rule lints over existing content (warnings and blocking rules alike), for views and the inspector. */
export function lintBrandRules(stage: Pick<Stage, 'read'>, nodes: readonly NodeId[], kit: BrandKitView): BrandViolation[] {
  const out: BrandViolation[] = [];
  const rules = kit.rules();
  for (const node of nodes) {
    const composed = stage.read(node);
    if (composed === undefined) continue;
    for (const rule of rules) {
      if (!applies(rule, composed.kind, composed.values['role'])) continue;
      const value = ruleValue(stage, node, rule.path);
      if (!allowed(rule, value)) out.push({ rule, node, value });
    }
  }
  return out;
}

/** The value a rule talks about: the winning opinion as written (a `@token` stays a token, not its colour). */
export function ruleValue(stage: Pick<Stage, 'read'>, node: NodeId, path: PropertyPath): JsonValue | undefined {
  const composed = stage.read(node);
  const winner = composed?.provenance[path];
  if (winner?.token !== undefined) return `@${winner.token.path.slice(`${P.tokens}.`.length)}`;
  return composed?.values[path];
}

/** A rule context over a stage and a kit. */
export function stageRuleContext(stage: Pick<Stage, 'read'>, kit: BrandKitView): RuleContext {
  return { kit, value: (node, path) => ruleValue(stage, node, path), kind: (node) => stage.read(node)?.kind };
}
