/** Type-ahead (APG menus, trees, listboxes). */

/** Index of the next item whose label starts with `char`, after `from` (wrapping); -1 if none. */
export function typeaheadIndex(labels: readonly string[], from: number, char: string): number {
  const needle = char.toLowerCase();
  for (let step = 1; step <= labels.length; step += 1) {
    const i = (from + step) % labels.length;
    if ((labels[i] ?? '').toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}
