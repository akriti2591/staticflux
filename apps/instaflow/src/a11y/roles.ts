/**
 * Roles of canvas elements for assistive technology (IF-25.4, IF-25.5): data tables, never branches on mode or lens
 * (rule 4). A new element kind, shape or semantic role adds a row.
 *
 * - `ELEMENT_A11Y_ROLES` — element kind → ARIA role and role description (`frame` → group "frame", `shape` → img …).
 * - `KIND_SHAPE_DESCRIPTIONS` — per kind, `geometry.shape` → a finer role description (`shape` + `rect` → "rectangle");
 *   an unset shape is B1's `Geometry` default.
 * - `REPEAT_DESCRIPTIONS` — `repeat.kind` → the description of a live repeat group ("radial repeat").
 * - `SEMANTIC_A11Y_ROLES` — the element's semantic `role` (IF-4.1) → an ARIA override (`headline` → heading level 1),
 *   taken from B2's `SEMANTIC_TEXT_ROLES` for headings and kept to roles that may carry a name (WAI-ARIA forbids a
 *   name on `paragraph` and `note` is not focusable content, so those stay the kind's role).
 * - `a11yRoleOf(kind, shape, semantic, repeat)` — the merged answer.
 */
import { Geometry } from '../elements/components.js';
import { SEMANTIC_TEXT_ROLES } from '../text/a11y.js';

export interface A11yRole {
  /** ARIA role of the projected node. Only roles that allow a name and a roving tabindex. */
  readonly role: 'group' | 'img' | 'heading';
  /** `aria-roledescription` (what a screen reader says instead of the bare role). */
  readonly roleDescription: string;
  /** Heading level (role heading only). */
  readonly level?: number;
}

/** Element kind → role (the canvas page itself is the projection root, not a node). */
export const ELEMENT_A11Y_ROLES: Readonly<Record<string, A11yRole>> = Object.freeze({
  frame: { role: 'group', roleDescription: 'frame' },
  group: { role: 'group', roleDescription: 'group' },
  shape: { role: 'img', roleDescription: 'shape' },
  vector: { role: 'img', roleDescription: 'vector' },
  image: { role: 'img', roleDescription: 'image' },
  text: { role: 'group', roleDescription: 'text' },
});

/** Fallback for kinds without a row (other work packages' kinds before they add one). */
export const DEFAULT_A11Y_ROLE: A11yRole = Object.freeze({ role: 'group', roleDescription: 'element' });

/** Element kind → (`geometry.shape` → role description). Kinds without a row keep their kind's description. */
export const KIND_SHAPE_DESCRIPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  shape: Object.freeze({ rect: 'rectangle', ellipse: 'ellipse', polygon: 'polygon', star: 'star', line: 'line' }),
});

/** The shape of an element whose `geometry.shape` is unset (B1's component default). */
export const DEFAULT_SHAPE = String(Geometry.defaults['shape']);

/** `repeat.kind` → role description of a live repeat group (B7). */
export const REPEAT_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  radial: 'radial repeat',
  grid: 'grid repeat',
  mirror: 'mirror repeat',
});

/** Semantic role → ARIA override: headings only (from B2's table), so headlines read as headings with a level. */
export const SEMANTIC_A11Y_ROLES: Readonly<Record<string, A11yRole>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SEMANTIC_TEXT_ROLES)
      .filter(([, r]) => r.role === 'heading')
      .map(([name, r]) => [name, { role: 'heading', roleDescription: 'heading', ...(r.level === undefined ? {} : { level: r.level }) } satisfies A11yRole]),
  ),
);

/** The projected role of an element: kind row, refined by shape, repeat kind and semantic role (in that order). */
export function a11yRoleOf(kind: string, shape?: string, semantic?: string, repeat?: string): A11yRole {
  const base = ELEMENT_A11Y_ROLES[kind] ?? DEFAULT_A11Y_ROLE;
  const described = { ...base, roleDescription: REPEAT_DESCRIPTIONS[repeat ?? ''] ?? KIND_SHAPE_DESCRIPTIONS[kind]?.[shape ?? DEFAULT_SHAPE] ?? base.roleDescription };
  return SEMANTIC_A11Y_ROLES[semantic ?? ''] ?? described;
}
