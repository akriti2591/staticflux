/**
 * Studio's shortcut list for Settings › Keyboard shortcuts on Home (B11c; STUDIO-UX-SPEC §2.3.1). Studio's shortcut
 * registry is the source of truth, but Home never loads Studio (D17); so Studio writes the cheat sheet's groups (a
 * snapshot of its registry, `shortcutSheet`) to this device each time it opens, and Home's Settings shows that
 * snapshot next to Home's own card. Per device (`instaflow/ui/shortcuts`); tolerant reads.
 */
import type { ShortcutSheetGroup } from '@staticflux/kit/shortcut-sheet';

export const SHORTCUTS_SNAPSHOT_KEY = 'instaflow/ui/shortcuts';

/** The groups Studio last registered on this device (empty when Studio never opened here, or on bad data). */
export function readShortcutsSnapshot(storage: Pick<Storage, 'getItem'> | undefined): readonly ShortcutSheetGroup[] {
  try {
    const raw = storage?.getItem(SHORTCUTS_SNAPSHOT_KEY);
    const value = raw === null || raw === undefined ? [] : (JSON.parse(raw) as unknown);
    if (!Array.isArray(value)) return [];
    return value.flatMap((g): ShortcutSheetGroup[] => {
      if (typeof g !== 'object' || g === null || typeof g.heading !== 'string' || !Array.isArray(g.rows)) return [];
      const rows = (g.rows as unknown[]).flatMap((r) => {
        const row = r as { id?: unknown; label?: unknown; keys?: unknown };
        return typeof row.id === 'string' && typeof row.label === 'string' && Array.isArray(row.keys) && row.keys.every((k) => typeof k === 'string') ? [{ id: row.id, label: row.label, keys: row.keys as string[] }] : [];
      });
      return rows.length === 0 ? [] : [{ heading: g.heading, rows }];
    });
  } catch {
    return [];
  }
}

/** Remember Studio's groups (combos as strings). */
export function writeShortcutsSnapshot(storage: Pick<Storage, 'setItem'> | undefined, groups: readonly ShortcutSheetGroup[]): void {
  try {
    const plain = groups.map((g) => ({ heading: g.heading, rows: g.rows.map((r) => ({ id: r.id, label: r.label, keys: r.keys.map((k) => (typeof k === 'string' ? k : String(k))) })) }));
    storage?.setItem(SHORTCUTS_SNAPSHOT_KEY, JSON.stringify(plain));
  } catch {
    // A convenience only.
  }
}

/** Reset hints (Settings › General): every first-use hint and Home's welcome card show again on this device. */
export function resetHintsOnDevice(storage: Pick<Storage, 'removeItem' | 'key' | 'length'> | undefined, prefixes: readonly string[]): void {
  try {
    if (storage === undefined) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k !== null && prefixes.some((p) => k === p || k.startsWith(`${p}/`))) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // A convenience only.
  }
}

/** What `Reset hints` clears: Studio's hint seen store and Home's first run (OVERLAYS §5, HOME-FILES §1.4). */
export const HINT_STORAGE_PREFIXES = ['instaflow/ui/hints', 'instaflow/ui/first-run'] as const;
