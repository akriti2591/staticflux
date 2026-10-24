/**
 * Mock data routes (R9.7): every endpoint of app/endpoints.ts answered from the
 * mock server. The "cookie" is implicit: handlers read `server.sessionUser`, like
 * a BFF that reads its HttpOnly session cookie.
 */
import { createMockTransport, mockStatus, type MockTransport, type MockTransportOptions } from '@staticflux/data';
import {
  AgentReplyEndpoint,
  BillingBalanceEndpoint,
  type DocsPage,
  DocGetEndpoint,
  DocSaveEndpoint,
  DocsListEndpoint,
  ExportPdfEndpoint,
  MeterCommitEndpoint,
  MeterReleaseEndpoint,
  MeterReserveEndpoint,
  type ReplyChunk,
  RemoteFlagsEndpoint,
  UserBatchProfilesEndpoint,
} from '../app/endpoints.js';
import type { MockServer } from './server.js';

const PAGE_SIZE = 10;

/** Scripted agent: echoes, and calls the insert-image tool when asked for an image. */
export function scriptAgentReply(prompt: string): readonly ReplyChunk[] {
  const words = `You asked: “${prompt}”. Here is a suggestion for your document.`.split(' ');
  const chunks: ReplyChunk[] = words.map((word, i) => ({ type: 'text', delta: i === 0 ? word : ` ${word}` }));
  if (/image|picture|diagram/i.test(prompt)) {
    chunks.push({ type: 'tool', name: 'agent/insert-image', input: { src: 'https://picsum.invalid/seed/studio/640/360', alt: 'Generated illustration' } });
  }
  if (/paragraph|write/i.test(prompt)) {
    chunks.push({ type: 'tool', name: 'studio/insert-text', input: { text: `Draft paragraph about ${prompt.slice(0, 40)}.` } });
  }
  chunks.push({ type: 'done' });
  return chunks;
}

export function configureMockRoutes(mock: MockTransport, server: MockServer): MockTransport {
  const requireUser = () => server.sessionUser;
  return mock
    .route(DocsListEndpoint, ({ cursor }) => {
      if (requireUser() === undefined) return mockStatus(401, { error: 'login required' });
      const all = Object.values(server.state.docs).sort((a, b) => b.updatedAt - a.updatedAt);
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = all.slice(start, start + PAGE_SIZE).map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
      const page: DocsPage = { items, nextCursor: start + PAGE_SIZE < all.length ? String(start + PAGE_SIZE) : null };
      return page;
    })
    .route(DocGetEndpoint, ({ id }) => {
      if (requireUser() === undefined) return mockStatus(401, { error: 'login required' });
      const doc = server.state.docs[id];
      return doc === undefined ? mockStatus(404, { error: 'no such document' }) : structuredClone(doc);
    })
    .route(DocSaveEndpoint, ({ id, title, blocks }) => {
      if (requireUser() === undefined) return mockStatus(401, { error: 'login required' });
      return { savedAt: server.saveDoc(id, title, blocks) };
    })
    .route(UserBatchProfilesEndpoint, (ids) =>
      ids.map((id) => {
        const user = server.state.users[id];
        return { id, name: user?.name ?? id, color: user?.color ?? '#64748b' };
      }),
    )
    .routeStream(AgentReplyEndpoint, async function* ({ prompt }, context) {
      for (const chunk of scriptAgentReply(prompt)) {
        await context.sleep(0);
        yield chunk;
      }
    })
    .route(BillingBalanceEndpoint, () => {
      const user = requireUser();
      return user === undefined ? mockStatus(401, {}) : { credits: user.credits, plan: user.plan };
    })
    .route(MeterReserveEndpoint, ({ amount }) => {
      const user = requireUser();
      if (user === undefined) return mockStatus(401, {});
      const held = Object.values(server.state.reservations)
        .filter((r) => r.userId === user.id && r.state === 'held')
        .reduce((sum, r) => sum + r.amount, 0);
      if (user.credits - held < amount) return mockStatus(402, { error: 'insufficient credits' });
      const id = `res-${server.state.nextReservation}`;
      server.state.nextReservation += 1;
      server.state.reservations[id] = { id, userId: user.id, amount, state: 'held' };
      return { reservationId: id, balance: user.credits };
    })
    .route(MeterCommitEndpoint, ({ reservationId, actual }) => {
      const reservation = server.state.reservations[reservationId];
      const user = reservation === undefined ? undefined : server.state.users[reservation.userId];
      if (reservation === undefined || user === undefined || reservation.state !== 'held') return mockStatus(409, {});
      reservation.state = 'committed';
      user.credits -= actual;
      server.persist();
      return { balance: user.credits };
    })
    .route(MeterReleaseEndpoint, ({ reservationId }) => {
      const reservation = server.state.reservations[reservationId];
      const user = reservation === undefined ? undefined : server.state.users[reservation.userId];
      if (reservation === undefined || user === undefined) return mockStatus(404, {});
      reservation.state = 'released';
      return { balance: user.credits };
    })
    .route(RemoteFlagsEndpoint, () => ({ ...server.state.flags }))
    .route(ExportPdfEndpoint, ({ id }) => ({ url: `blob:studio/export/${id}.pdf` }));
}

export function createStudioMockTransport(server: MockServer, options: MockTransportOptions = {}): MockTransport {
  return configureMockRoutes(createMockTransport(options), server);
}
