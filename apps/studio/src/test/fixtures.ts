/** Shared helpers for the integration tests. */
import type { SpanEndRecord, TelemetryRecord } from '@staticflux/core';
import { createMockServer, type MockServer } from '../mocks/server.js';

/** A mock server with `userId` already signed in at the BFF (cookie present). */
export function signedInServer(userId: 'ada' | 'grace'): MockServer {
  const server = createMockServer();
  server.state.session = { userId, csrf: 'csrf-1', rotation: 1 };
  return server;
}

export function spans(records: readonly TelemetryRecord[]): SpanEndRecord[] {
  return records.filter((r): r is SpanEndRecord => r.type === 'span');
}
