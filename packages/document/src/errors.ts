/**
 * Error catalog for @staticflux/document (`SF-DOC-*`). v1 (ECS engine): 001–007;
 * v2 (DocumentCRDT v2, DocumentRepo, components, canonical parts): 008–019.
 * Validation of a v2 field value reuses SF-DOC-003 (`InvalidFieldError`).
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

// ---------------------------------------------------------------- DocumentCRDT v2, DocumentRepo, components (SF-Δ3–Δ6)

export const UnknownNodeError = defineError(
  'SF-DOC-008',
  'not-found',
  'The node does not exist in this part (never created, deleted, or living in another part).',
  'Check `crdt.has(node)` first; a concurrent peer may have deleted it, so treat this as a normal outcome and re-read.',
);

export const MoveCycleError = defineError(
  'SF-DOC-009',
  'validation',
  'The move would make a node its own ancestor.',
  'Pick a parent outside the moved subtree. Concurrent cyclic moves are resolved by the movable tree; only local ones are rejected.',
);

export const VersionUnavailableError = defineError(
  'SF-DOC-010',
  'not-found',
  'The version (frontier) is not in this part’s retained history (trimmed by a shallow compaction, or from an unknown peer).',
  'Re-read the current state and use its frontier as the new base; treat older bases as “everything may have changed”.',
);

export const HeadConflictError = defineError(
  'SF-DOC-011',
  'conflict',
  'The document head changed since it was read (compare-and-swap on `generation` failed).',
  'Reload the head and retry; `compact()` retries automatically a few times before returning this error.',
);

export const MissingBlobError = defineError(
  'SF-DOC-012',
  'not-found',
  'A blob named by the head (part snapshot or undo history) is missing from the store.',
  'Check the store backend; the head must never name a blob before `putBlob` resolved. Reopen from a backup or milestone.',
);

export const UnknownPartError = defineError(
  'SF-DOC-013',
  'not-found',
  'The part is not loaded (or not known to this document).',
  'Await `doc.part(id, signal)` before writing to it, or create it with `doc.createPart(id)`.',
);

export const DocumentClosedError = defineError(
  'SF-DOC-014',
  'invariant',
  'The document, part or gesture was used after it was closed, evicted or disposed.',
  'Reopen it through the repo (`repo.open(asset, signal)` / `doc.part(id, signal)`); never keep references across close.',
);

export const PartBusyError = defineError(
  'SF-DOC-015',
  'conflict',
  'The part cannot be evicted while it has commits that are not yet durable.',
  'Await the pending commits (or `doc.flush(signal)`) and evict again; eviction never drops unacknowledged edits.',
);

export const MigrationError = defineError(
  'SF-DOC-016',
  'validation',
  'A component value could not be migrated to the current component version.',
  'Declare a migration for every version step in `defineComponent(id, schema, { version, migrations })`; migrations must be pure.',
);

export const CanonicalEncodingError = defineError(
  'SF-DOC-017',
  'validation',
  'The value cannot be canonically encoded (RFC 8785): non-finite number, lone surrogate or non-JSON data.',
  'Store only finite numbers, well-formed strings and plain objects/arrays in document properties.',
);

export const HandleLeakError = defineError(
  'SF-DOC-018',
  'invariant',
  'CRDT engine handles are still alive after the document was disposed (dev-mode handle accounting).',
  'Free every engine handle in a `finally` (the Loro adapter does this); run the leak test in the DocumentCRDT contract suite.',
);

export const NodeExistsError = defineError(
  'SF-DOC-019',
  'conflict',
  'A node with this id already exists in the part.',
  'Generate a fresh id (`createIdGenerator`) or update the existing node; ids are asset-local and never reused.',
);
