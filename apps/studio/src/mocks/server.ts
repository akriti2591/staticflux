/**
 * The mock backend: one in-memory "server" (BFF session, documents, credits,
 * remote flags) shared by the mock data transport, the mock auth endpoints and the
 * mock meter backend. Its state outlives app boots, so a test can "reload the page"
 * (boot a second app) against the same server — exactly like a real BFF would.
 *
 * In the browser the state is persisted to localStorage so the BFF login redirect
 * (a real page reload) keeps the session. Everything here is test/demo code.
 */
import type { BlockRecord, DocumentRecord } from '../app/endpoints.js';

export type Plan = 'free' | 'pro';

export interface MockUser {
  readonly id: string;
  readonly name: string;
  plan: Plan;
  credits: number;
  entitlements: string[];
  readonly color: string;
}

export interface MockReservation {
  readonly id: string;
  readonly userId: string;
  readonly amount: number;
  state: 'held' | 'committed' | 'released';
}

export interface MockServerState {
  users: Record<string, MockUser>;
  docs: Record<string, DocumentRecord>;
  session: { userId: string | undefined; csrf: string; rotation: number };
  flags: Record<string, unknown>;
  reservations: Record<string, MockReservation>;
  nextReservation: number;
}

export interface PersistPort {
  load(): string | undefined;
  save(value: string): void;
}

export interface MockServer {
  readonly state: MockServerState;
  /** Called by the mock BFF login page: authenticates `hint` and returns the `returnTo` path. */
  completeBffLogin(url: string): string;
  /** The current session user (undefined = anonymous). */
  readonly sessionUser: MockUser | undefined;
  /** Change the plan of the session user and rotate the session token (claims change). */
  upgrade(userId: string, plan: Plan): void;
  saveDoc(id: string, title: string, blocks: readonly BlockRecord[]): number;
  now(): number;
  persist(): void;
}

const SEED_USERS: Record<string, MockUser> = {
  ada: { id: 'ada', name: 'Ada (free)', plan: 'free', credits: 10, entitlements: [], color: '#8b5cf6' },
  grace: { id: 'grace', name: 'Grace (pro)', plan: 'pro', credits: 100, entitlements: ['ai'], color: '#0ea5e9' },
};

function seedDocs(now: number): Record<string, DocumentRecord> {
  const docs: Record<string, DocumentRecord> = {};
  for (let i = 1; i <= 24; i += 1) {
    const id = String(i);
    docs[id] = {
      id,
      title: i === 1 ? 'Welcome to Studio' : `Document ${i}`,
      ownerId: 'shared',
      updatedAt: now - i * 60_000,
      blocks: [
        { kind: 'text', text: i === 1 ? 'Studio is a StaticFlux example: an AI-assisted mixed-media editor.' : `Notes for document ${i}.` },
        { kind: 'text', text: 'Edits are intents to the document worker; the page holds a read-only replica.' },
        ...(i === 1 ? [{ kind: 'image' as const, src: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', text: 'Diagram' }] : []),
      ],
    };
  }
  return docs;
}

function initialState(now: number): MockServerState {
  return {
    users: structuredClone(SEED_USERS),
    docs: seedDocs(now),
    session: { userId: undefined, csrf: 'csrf-0', rotation: 0 },
    flags: { 'studio/ai-suggestions': true, 'onboarding/variant': 'B' },
    reservations: {},
    nextReservation: 1,
  };
}

export function createMockServer(options: { readonly now?: () => number; readonly persist?: PersistPort } = {}): MockServer {
  const now = options.now ?? (() => Date.now());
  let state = initialState(now());
  const stored = options.persist?.load();
  if (stored !== undefined) {
    try {
      state = { ...state, ...(JSON.parse(stored) as Partial<MockServerState>) };
    } catch {
      // corrupt demo state: start fresh
    }
  }
  const persist = (): void => options.persist?.save(JSON.stringify(state));

  return {
    get state() {
      return state;
    },
    get sessionUser() {
      const id = state.session.userId;
      return id === undefined ? undefined : state.users[id];
    },
    completeBffLogin(url) {
      const parsed = new URL(url, 'https://studio.invalid');
      const hint = parsed.searchParams.get('login_hint') ?? 'ada';
      const user = state.users[hint] ?? state.users['ada'];
      state.session = { userId: user?.id, csrf: `csrf-${state.session.rotation + 1}`, rotation: state.session.rotation + 1 };
      persist();
      const returnTo = parsed.searchParams.get('returnTo');
      return returnTo !== null && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
    },
    upgrade(userId, plan) {
      const user = state.users[userId];
      if (user === undefined) return;
      user.plan = plan;
      user.entitlements = plan === 'pro' ? ['ai'] : [];
      state.session = { ...state.session, csrf: `csrf-${state.session.rotation + 1}`, rotation: state.session.rotation + 1 };
      persist();
    },
    saveDoc(id, title, blocks) {
      const existing = state.docs[id];
      const savedAt = now();
      state.docs[id] = { id, title, ownerId: existing?.ownerId ?? 'shared', updatedAt: savedAt, blocks: [...blocks] };
      persist();
      return savedAt;
    },
    now,
    persist,
  };
}

/** localStorage persistence for the browser demo (feature-detected; memory otherwise). */
export function localStoragePersist(key = 'studio/mock-server'): PersistPort | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage === undefined) return undefined;
    return {
      load: () => storage.getItem(key) ?? undefined,
      save: (value) => storage.setItem(key, value),
    };
  } catch {
    return undefined;
  }
}
