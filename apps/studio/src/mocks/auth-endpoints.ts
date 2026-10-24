/**
 * Mock BFF endpoints for the `bff-cookie` provider (R6.1): a session endpoint, a
 * login page (full-page redirect target), logout and refresh. The provider talks
 * to them through its `AuthTransport` port exactly as it would to a real BFF.
 */
import type { AuthRequest, AuthResponse, AuthTransport } from '@staticflux/auth';
import type { MockServer } from './server.js';

export const BFF_ENDPOINTS = {
  session: '/mock-bff/session',
  login: '/mock-bff/login',
  logout: '/mock-bff/logout',
  refresh: '/mock-bff/refresh',
} as const;

export const CSRF_HEADER = 'X-CSRF-Token';

const respond = (status: number, body: unknown): AuthResponse => ({ status, json: () => Promise.resolve(body) });

function sessionBody(server: MockServer): unknown {
  const user = server.sessionUser;
  if (user === undefined) return { authenticated: false };
  return {
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      roles: ['member'],
      claims: { plan: user.plan, entitlements: [...user.entitlements], rotation: server.state.session.rotation },
    },
    expiresAt: server.now() + 60 * 60_000,
    csrfToken: server.state.session.csrf,
  };
}

/** The mock BFF as an `AuthTransport` (async like the network; honours the signal). */
export function createMockBffTransport(server: MockServer): AuthTransport {
  return async (request: AuthRequest): Promise<AuthResponse> => {
    await Promise.resolve();
    if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const path = new URL(request.url, 'https://studio.invalid').pathname;
    if (path === BFF_ENDPOINTS.session && request.method === 'GET') {
      return server.sessionUser === undefined ? respond(401, { authenticated: false }) : respond(200, sessionBody(server));
    }
    if (path === BFF_ENDPOINTS.logout && request.method === 'POST') {
      server.state.session = { ...server.state.session, userId: undefined };
      server.persist();
      return respond(204, undefined);
    }
    if (path === BFF_ENDPOINTS.refresh && request.method === 'POST') {
      if (server.sessionUser === undefined) return respond(401, {});
      // Double-submit check (the token rotates with the session, so any issued token is accepted here).
      if (request.headers?.[CSRF_HEADER]?.startsWith('csrf-') !== true) return respond(403, { error: 'csrf' });
      return respond(200, { rotated: true });
    }
    return respond(404, { error: 'not found' });
  };
}

/** True for the mock BFF login page (the `navigate` target of a login redirect). */
export function isMockLoginUrl(url: string): boolean {
  return new URL(url, 'https://studio.invalid').pathname === BFF_ENDPOINTS.login;
}
