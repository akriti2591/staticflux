/**
 * Studio's part ids (B8): the root part (composition and page stubs) and one part per page. Split from `document.ts`
 * (#62) so code that only names parts (find and replace, the Studio frame's registries) does not load the document
 * engine (loro-crdt fetches its Wasm synchronously when its module evaluates).
 */
import type { NodeId, PartId } from '@staticflux/document/v2';

export const ROOT_PART: PartId = 'root';
export const pagePart = (page: NodeId): PartId => `page:${page}`;
