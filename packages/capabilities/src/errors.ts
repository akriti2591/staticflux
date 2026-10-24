import { defineError } from '@staticflux/core';

export const UnknownCapabilityError = defineError(
  'SF-CAP-001',
  'not-found',
  'No capability with this id is declared.',
  'Declare it with `registry.declare(capability)` or a `capabilityDeclarationUnit(capability)`; agents should list tools before calling them.',
);

export const SchemaValidationError = defineError(
  'SF-CAP-002',
  'validation',
  'A value does not match the capability schema.',
  'Fix the caller (see `details.issues`, one entry per problem). Agent input is untrusted; never loosen the schema to make a bad call pass.',
);

export const CapabilityDeniedError = defineError(
  'SF-CAP-003',
  'forbidden',
  'The policy decision denied this capability for this subject.',
  'Show the reason (`details.reason`: login, upgrade, forbidden, unavailable, quota, rate) instead of retrying. Client gating is UX — the server re-checks.',
);

export const ConfirmationDeclinedError = defineError(
  'SF-CAP-004',
  'forbidden',
  'The user declined (or could not be asked) to confirm this capability call.',
  'Expected for destructive agent actions the user rejected. Do not retry automatically; let the user or agent ask again.',
);

export const NoConfirmerError = defineError(
  'SF-CAP-005',
  'unavailable',
  'The call needs confirmation but no confirmation port is bound.',
  'Bind a `CapabilityConfirmPortToken` unit (e.g. a messaging confirm dialog). The default port fails closed on purpose.',
);

export const NotImplementedError = defineError(
  'SF-CAP-006',
  'unavailable',
  'The capability is declared but no implementation is registered.',
  'Register one with `registry.provide(implementation, scope)` when the owning feature activates, or set `feature` on the declaration so invoke can activate it.',
);

export const InvalidOutputError = defineError(
  'SF-CAP-007',
  'invariant',
  "A capability implementation returned a value that does not match its output schema.",
  'Fix the implementation (see `details.issues`). The output schema is the contract agents rely on.',
);

export const ActivationFailedError = defineError(
  'SF-CAP-008',
  'unavailable',
  "The capability's owning feature could not be activated.",
  'Inspect `cause` (chunk load, gating, init failure). The feature-activation port decides how features load.',
);

export const DuplicateCapabilityError = defineError(
  'SF-CAP-009',
  'invariant',
  'Two different declarations (or two live implementations) use the same capability id.',
  'Capability ids are namespaced (`feature/action`) and must be unique; dispose the previous registration scope first.',
);

export const ImplementationFailedError = defineError(
  'SF-CAP-010',
  'unknown',
  'A capability implementation threw instead of returning a Result.',
  'Return `err(...)` with a typed SfError from the implementation; see `cause`.',
);
