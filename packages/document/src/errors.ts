/**
 * Error catalog for @staticflux/document (`SF-DOC-*`).
 */
import { defineError } from '@staticflux/core';

export const UnknownComponentError = defineError(
  'SF-DOC-001',
  'validation',
  'The component is not registered with this document engine.',
  'Pass the component definition in `createDocumentEngine({ components: [...] })` (on every peer and worker).',
);

export const UnknownEntityError = defineError(
  'SF-DOC-002',
  'not-found',
  'The entity does not exist (never created, or deleted).',
  'Check `engine.has(entity)` first; a concurrent peer may have deleted it — treat this as a normal outcome.',
);

export const InvalidFieldError = defineError(
  'SF-DOC-003',
  'validation',
  'A component value does not match its schema (unknown field or wrong type).',
  'Use the field names and types declared in `defineComponent(id, schema)`.',
);

export const TextRangeError = defineError(
  'SF-DOC-004',
  'validation',
  'A text edit is out of range or targets a non-text component.',
  'Clamp indices to `engine.text(entity, component).length`; use `defineTextComponent` for CRDT text.',
);

export const UnsupportedArchiveError = defineError(
  'SF-DOC-005',
  'validation',
  'The document archive has an unsupported format or version.',
  'Migrate the archive with the matching engine version before restoring it.',
);

export const InvalidUpdateError = defineError(
  'SF-DOC-006',
  'validation',
  'A CRDT update could not be decoded or applied.',
  'Only feed bytes produced by `encodeUpdate()` / `onLocalUpdate()` of a compatible engine; request a full resync.',
);

export const CollaborationClosedError = defineError(
  'SF-DOC-007',
  'aborted',
  'The collaboration session is closed.',
  'Re-join the room; the engine resyncs with its state vector on reconnect.',
);
