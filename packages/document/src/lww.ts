/**
 * Last-writer-wins map: one register per property, ordered by
 * (Lamport clock, actor). A delta-state CRDT: `diff(stateVector)` returns the
 * winning registers the peer has not seen. Assumes each peer's updates are
 * delivered in order (or a full sync), which the collaboration transport and
 * worker ports guarantee.
 */

export interface LwwEntry {
  readonly key: string;
  readonly value: unknown;
  readonly clock: number;
  readonly actor: number;
}

export type LwwStateVector = Readonly<Record<string, number>>;

export interface LwwMap {
  readonly actor: number;
  /** Current Lamport clock. */
  readonly clock: number;
  get(key: string): unknown;
  has(key: string): boolean;
  /** Local write; returns the entry to broadcast. */
  set(key: string, value: unknown): LwwEntry;
  /** Merge remote entries; returns keys whose winning value changed. */
  merge(entries: readonly LwwEntry[]): readonly string[];
  stateVector(): LwwStateVector;
  diff(stateVector?: LwwStateVector): readonly LwwEntry[];
  keys(): IterableIterator<string>;
}

function wins(a: LwwEntry, b: LwwEntry): boolean {
  return a.clock > b.clock || (a.clock === b.clock && a.actor > b.actor);
}

export function isLwwEntry(value: unknown): value is LwwEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['key'] === 'string' && typeof v['clock'] === 'number' && typeof v['actor'] === 'number' && 'value' in v;
}

export function createLwwMap(actor: number): LwwMap {
  const registers = new Map<string, LwwEntry>();
  const seen = new Map<number, number>();
  let clock = 0;

  const observe = (entry: LwwEntry): void => {
    if (entry.clock > clock) clock = entry.clock;
    if ((seen.get(entry.actor) ?? 0) < entry.clock) seen.set(entry.actor, entry.clock);
  };

  return {
    actor,
    get clock() {
      return clock;
    },
    get: (key) => registers.get(key)?.value,
    has: (key) => registers.has(key),
    set(key, value) {
      clock += 1;
      const entry: LwwEntry = { key, value, clock, actor };
      registers.set(key, entry);
      observe(entry);
      return entry;
    },
    merge(entries) {
      const changed: string[] = [];
      for (const entry of entries) {
        observe(entry);
        const current = registers.get(entry.key);
        if (current === undefined || wins(entry, current)) {
          registers.set(entry.key, entry);
          if (current === undefined || !Object.is(current.value, entry.value) || typeof entry.value === 'object') changed.push(entry.key);
        }
      }
      return changed;
    },
    stateVector() {
      const out: Record<string, number> = {};
      for (const [a, c] of seen) out[String(a)] = c;
      return out;
    },
    diff(stateVector = {}) {
      const out: LwwEntry[] = [];
      for (const entry of registers.values()) {
        if (entry.clock > (stateVector[String(entry.actor)] ?? 0)) out.push(entry);
      }
      return out;
    },
    keys: () => registers.keys(),
  };
}
