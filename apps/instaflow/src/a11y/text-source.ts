/**
 * B2 → B6 seam: the plain text of text elements, read from the page part with B2's `readTextBlock`, for the
 * projection's `text` port (names and searchable DOM text). Non-text nodes and unreadable blocks give undefined.
 */
import type { DocumentCRDTv2, NodeId } from '@staticflux/document/v2';
import { readTextBlock } from '../text/rich-text.js';

/** A `TextSource` over one page part (the part holds the text CRDT; the stage holds only composed values). */
export function partTextSource(part: DocumentCRDTv2): (node: NodeId) => string | undefined {
  return (node) => {
    const block = readTextBlock(part, node);
    return block.ok ? block.value.text : undefined;
  };
}
