/**
 * Strings of the accessibility layer (one place for translation; no string literals in the projection or the
 * announcer). Functions take counts and names and return plain text for `aria-label`, `aria-description` and the
 * polite live region.
 */
export const a11yMessages = Object.freeze({
  /** Label of the projection root inside the canvas surface. */
  canvas: (page: string): string => `Canvas: ${page}`,
  /** How to work the canvas from the keyboard (the root's description; no keyboard trap, SC 2.1.2). */
  instructions:
    'Tab and Shift+Tab move between elements, Enter selects inside, Shift+Enter selects the parent, Escape clears the selection, arrow keys nudge. Alt+Enter goes to the actions, Mod+K to the command bar.',
  /** Name of an element without a name or text: its role description, capitalised. */
  unnamed: (roleDescription: string): string => `${roleDescription.slice(0, 1).toUpperCase()}${roleDescription.slice(1)}`,
  /** A repeat instance (1-based for people). */
  instance: (k: number, n: number): string => `instance ${k} of ${n}`,
  /** A live repeat group's description. */
  repeatCount: (n: number): string => `${n} ${n === 1 ? 'instance' : 'instances'}`,
  locked: 'locked',
  positionLocked: 'position locked',
  /** Selection announcements (polite). */
  selectedOne: (name: string, role: string, extra: string): string => `${name}, ${role}${extra === '' ? '' : `, ${extra}`}, selected`,
  selectedMany: (n: number): string => `${n} elements selected`,
  cleared: 'Selection cleared',
  inside: (name: string): string => `Inside ${name}`,
  /** `describe-canvas` output joiner. */
  nothingSelected: 'Nothing selected',
  visibleCount: (n: number): string => `${n} ${n === 1 ? 'element' : 'elements'} in view`,
});

/** Longest accessible name taken from text content (a name is a label, not the whole text; the text stays in the DOM). */
export const NAME_MAX_CHARS = 80;
