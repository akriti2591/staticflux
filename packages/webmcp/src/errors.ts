import { defineError } from '@staticflux/core';

export const WebMcpUnsupportedError = defineError(
  'SF-MCP-001',
  'unavailable',
  'This browser exposes no WebMCP model context (navigator.modelContext / document.modelContext).',
  'Expected outside Chrome with the WebMCP flag/origin trial. Agents fall back to other channels; nothing to fix in app code.',
);

export const ToolRegistrationError = defineError(
  'SF-MCP-002',
  'invariant',
  'The browser rejected a WebMCP tool registration.',
  'Usually a duplicate tool name or invalid schema (see `cause`). Tool names derive from capability ids, which must be unique.',
);

export const PublisherDisposedError = defineError(
  'SF-MCP-003',
  'aborted',
  'The WebMCP publisher was disposed; its tools are no longer registered.',
  'Expected when the owning scope ends. Agents must re-list tools.',
);
