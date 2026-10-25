/** Document-unique ids for ARIA references inside one tree. */

let idCounter = 0;

/** A document-unique id with a readable prefix (`sf-tab-3`). */
export function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}
