/**
 * The Home model (C0; IF-28.12–28.16): headless state and actions behind `<if-home>`. It reads the Home index from
 * the workspace store (no document engine, D17), derives recents, files and templates, and runs Home's capabilities
 * (D18) through one registry, the same pipeline agents use. An action resolves to a Studio href; the host navigates.
 *
 * Lifecycle `instaflow/home` (LIFECYCLES §30): loading → ready | failed; ready | failed → loading (`refresh`: the page
 * came back from the back/forward cache, the tab became visible, "Try again"); any → disposed.
 */
import { alwaysActivePort, allowAllDecidePort, type CapabilityRegistry, createCapabilityRegistry, failClosedConfirmPort, implementCapability, unmeteredPort } from '@staticflux/capabilities';
import { box, createMachine, defineMachine, err, ok, type Result, type SfError } from '@staticflux/core';
import type { DocumentStore } from '@staticflux/document/v2';
import type { LibraryAssetKind } from '../library/kinds.js';
import { LIBRARY_ASSET } from '../library/library-doc.js';
import { HOME_CAPABILITIES, HOME_QUICK_ACTIONS, type HomeActionOutput, type HomeQuickAction, NewDesignCapability, OpenDesignCapability, UseTemplateCapability } from './capabilities.js';
import { HomeIndexReadError, HomeRouteError, UnknownDesignError, UnknownTemplateError } from './errors.js';
import type { DesignFormatId } from './formats.js';
import { EMPTY_HOME_INDEX, type HomeEntry, type HomeIndex, readHomeIndex, recentDesigns, workspaceFiles, workspaceTemplates } from './index-record.js';
import { newDesignHref, studioHref } from './routes.js';

export const HomeMachine = /* @__PURE__ */ defineMachine({
  id: 'instaflow/home',
  initial: 'loading',
  states: ['loading', 'ready', 'failed', 'disposed'],
  transitions: {
    loading: { loaded: 'ready', fail: 'failed', dispose: 'disposed' },
    ready: { refresh: 'loading', dispose: 'disposed' },
    failed: { refresh: 'loading', dispose: 'disposed' },
  },
  terminal: ['disposed'],
});

export type HomeState = (typeof HomeMachine.states)[number];

/** Where the Home index comes from (structurally the workspace `DocumentStore`'s head read). */
export interface HomeIndexSource {
  read(signal: AbortSignal): Promise<Result<HomeIndex>>;
}

/** The Home index stored in the library head of `store` (an absent head is an empty workspace). */
export function storeIndexSource(store: Pick<DocumentStore, 'readHead'>): HomeIndexSource {
  return {
    async read(signal) {
      const head = await store.readHead(LIBRARY_ASSET, signal);
      if (!head.ok) return err(HomeIndexReadError({ cause: head.error }));
      return ok(readHomeIndex(head.value));
    },
  };
}

/** What Home asks of the page. */
export interface HomeHost {
  /** Go to a Studio href (a full navigation: Studio is another boot). */
  navigate(href: string): void;
}

export interface HomeModelOptions {
  readonly source: HomeIndexSource;
  readonly host: HomeHost;
  /** Everything stops with it (rule 5). */
  readonly signal: AbortSignal;
  /** The registry Home's capabilities go in (default: a local one with the default ports). */
  readonly capabilities?: CapabilityRegistry;
}

export interface HomeModel {
  /** Reactive. */
  readonly state: HomeState;
  /** Why the last read failed (reactive). */
  readonly error: SfError | undefined;
  /** The last index read (reactive; empty until the first read). */
  readonly index: HomeIndex;
  recents(): readonly HomeEntry[];
  files(): readonly HomeEntry[];
  templates(): readonly HomeEntry[];
  readonly quickActions: readonly HomeQuickAction[];
  readonly capabilities: CapabilityRegistry;
  /** Studio href for an entry (designs open, templates start a new design); undefined for media. */
  hrefOf(entry: HomeEntry): string | undefined;
  /** Read the index again. */
  refresh(): Promise<Result<HomeIndex>>;
  newDesign(format?: DesignFormatId): Promise<Result<HomeActionOutput>>;
  open(asset: string): Promise<Result<HomeActionOutput>>;
  useTemplate(template: string): Promise<Result<HomeActionOutput>>;
  runQuickAction(action: HomeQuickAction): Promise<Result<HomeActionOutput>>;
  dispose(): void;
}

/** Where each kind of entry leads (data, not a branch): designs open, templates start a design; media have no page yet. */
export const ENTRY_HREFS: Readonly<Partial<Record<LibraryAssetKind, (asset: string) => Result<string>>>> = Object.freeze({
  composition: (asset: string) => studioHref(asset),
  template: (asset: string) => newDesignHref({ template: asset }),
});

const built = (href: Result<string>): Result<string> => (href.ok ? href : err(HomeRouteError({ cause: href.error })));

/** Create the Home model and start the first read. */
export function createHomeModel(options: HomeModelOptions): HomeModel {
  const { source, host, signal } = options;
  const machine = createMachine(HomeMachine);
  const index = box<HomeIndex>(EMPTY_HOME_INDEX);
  const error = box<SfError | undefined>(undefined);
  const live = (): HomeIndex => index.get();
  const design = (asset: string): HomeEntry | undefined => live().entries.find((e) => e.asset === asset && e.kind === 'composition');
  const template = (asset: string): HomeEntry | undefined => live().entries.find((e) => e.asset === asset && e.kind === 'template');

  const go = (href: Result<string>): Result<HomeActionOutput> => {
    const out = built(href);
    if (!out.ok) return out;
    host.navigate(out.value);
    return ok({ href: out.value });
  };
  const owned = options.capabilities === undefined;
  const capabilities =
    options.capabilities ??
    createCapabilityRegistry({ decide: allowAllDecidePort, confirm: failClosedConfirmPort, meter: unmeteredPort, activation: alwaysActivePort, declarations: [...HOME_CAPABILITIES] });
  const implementations = [
    implementCapability(NewDesignCapability, async (input) => go(newDesignHref(input.format === undefined ? {} : { format: input.format }))),
    implementCapability(OpenDesignCapability, async (input) => (design(input.asset) === undefined ? err(UnknownDesignError({ details: { asset: input.asset } })) : go(studioHref(input.asset)))),
    implementCapability(UseTemplateCapability, async (input) =>
      template(input.template) === undefined ? err(UnknownTemplateError({ details: { template: input.template } })) : go(newDesignHref({ template: input.template })),
    ),
  ];
  const released = implementations.flatMap((impl) => {
    const provided = capabilities.provide(impl);
    return provided.ok ? [provided.value] : [];
  });

  let reads = 0;
  const refresh = async (): Promise<Result<HomeIndex>> => {
    if (machine.state === 'disposed') return ok(live());
    if (machine.state !== 'loading') machine.send('refresh');
    const read = (reads += 1);
    const result = await source.read(signal);
    if (read !== reads || machine.state !== 'loading') return result; // a newer read or dispose won
    if (result.ok) {
      index.set(result.value);
      error.set(undefined);
      machine.send('loaded');
    } else {
      error.set(result.error);
      machine.send('fail');
    }
    return result;
  };

  const invoke = <I>(capability: { readonly id: string }, input: I): Promise<Result<HomeActionOutput>> =>
    capabilities.invoke(capability.id, input, { subject: 'user', signal, origin: { channel: 'ui/home' } }) as Promise<Result<HomeActionOutput>>;

  const dispose = (): void => {
    if (machine.state === 'disposed') return;
    machine.send('dispose');
    for (const release of released) release();
    if (owned) capabilities.dispose();
  };
  signal.addEventListener('abort', dispose, { once: true });
  void refresh();

  return {
    get state() {
      return machine.state;
    },
    get error() {
      return error.get();
    },
    get index() {
      return live();
    },
    recents: () => recentDesigns(live()),
    files: () => workspaceFiles(live()),
    templates: () => workspaceTemplates(live()),
    quickActions: HOME_QUICK_ACTIONS,
    capabilities,
    hrefOf(entry) {
      const href = ENTRY_HREFS[entry.kind]?.(entry.asset);
      return href?.ok === true ? href.value : undefined;
    },
    refresh,
    newDesign: (format) => invoke(NewDesignCapability, format === undefined ? {} : { format }),
    open: (asset) => invoke(OpenDesignCapability, { asset }),
    useTemplate: (t) => invoke(UseTemplateCapability, { template: t }),
    runQuickAction: (action) => invoke(action.capability, action.input),
    dispose,
  };
}
