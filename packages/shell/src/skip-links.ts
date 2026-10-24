/**
 * Skip links and shell landmarks (R15.2, WCAG 2.4.1 "Bypass Blocks").
 *
 * `<sf-skip-links>` renders "Skip to main content" (and to other declared landmark
 * slots: navigation, side panel, …) as the first focusable content of `<sf-shell>`.
 * The links are visually hidden until focused; activating one moves focus to the
 * target slot region through the a11y focus manager (when the target lives in the
 * document) or directly (targets inside a shadow root — `<sf-shell>` regions).
 *
 * Labels are plain data (`ShellMessages`): the shell cannot depend on i18n, so apps bind
 * `ShellMessagesToken` to localized strings (re-bind / refresh on locale change) or set
 * the element's props directly.
 */
import { FocusTargetError, type FocusManager } from '@staticflux/a11y';
import { err, ok, type Result, token } from '@staticflux/core';
import { css, html, LitElement } from 'lit';
import type { BuiltInSlot, SlotId } from './slots.js';

// ---------------------------------------------------------------- landmarks

/** ARIA landmark role of a shell region. */
export type ShellLandmark = 'banner' | 'navigation' | 'main' | 'complementary' | 'region';

export const SLOT_LANDMARKS: Readonly<Record<BuiltInSlot, ShellLandmark>> = Object.freeze({
  header: 'banner',
  sidebar: 'navigation',
  main: 'main',
  panel: 'complementary',
});

/** Landmark of a slot; registered (non built-in) slots are named `region`s. */
export function landmarkOf(slot: SlotId): ShellLandmark {
  return (SLOT_LANDMARKS as Readonly<Partial<Record<string, ShellLandmark>>>)[slot] ?? 'region';
}

// ---------------------------------------------------------------- messages

export interface ShellMessages {
  /** Accessible name of the skip-link group. */
  readonly skipLinksLabel: string;
  /** Skip-link text per target slot; a target without text is not offered. */
  readonly skipTo: Readonly<Partial<Record<SlotId, string>>>;
  /** Accessible names of landmark regions (navigation, complementary, custom regions). */
  readonly regions: Readonly<Partial<Record<SlotId, string>>>;
}

export const defaultShellMessages: ShellMessages = Object.freeze({
  skipLinksLabel: 'Skip links',
  skipTo: Object.freeze({ main: 'Skip to main content', sidebar: 'Skip to navigation', panel: 'Skip to side panel' }),
  regions: Object.freeze({ sidebar: 'Navigation', panel: 'Side panel' }),
});

/** Optional binding: localized shell strings (app-provided, e.g. from its i18n catalog). */
export const ShellMessagesToken = /* @__PURE__ */ token('shell/messages').type<ShellMessages>();

// ---------------------------------------------------------------- skip targets

/** Default skip targets, in link order. Presets override with `skipTargets`. */
export const DEFAULT_SKIP_TARGETS: readonly SlotId[] = ['main', 'sidebar', 'panel'];

export interface SkipLink {
  readonly slot: SlotId;
  readonly label: string;
}

/** Skip links for the rendered regions, in `targets` order (pure). */
export function skipLinksFor(
  rendered: readonly SlotId[],
  targets: readonly SlotId[] = DEFAULT_SKIP_TARGETS,
  messages: ShellMessages = defaultShellMessages,
): readonly SkipLink[] {
  return targets.flatMap((slot) => {
    const label = messages.skipTo[slot];
    return rendered.includes(slot) && label !== undefined && label !== '' ? [{ slot, label }] : [];
  });
}

/** Attribute marking a shell region with its slot id (skip-link targets resolve by it). */
export const SLOT_ATTR = 'data-slot';

/**
 * Move focus to a skip target. Document-level targets go through the focus manager
 * (`focusRouteTarget`); targets in a shadow root are focused directly, because the
 * document's `activeElement` is then the shadow host.
 */
export function focusSkipTarget(target: Element | null | undefined, focusManager?: FocusManager): Result<Element> {
  if (!(target instanceof HTMLElement)) return err(FocusTargetError({ details: { reason: 'skip target not rendered' } }));
  if (focusManager !== undefined && target.getRootNode() === target.ownerDocument) {
    return focusManager.focusRouteTarget({ target, preventScroll: false });
  }
  if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus();
  const root = target.getRootNode() as Document | ShadowRoot;
  return root.activeElement === target ? ok(target) : err(FocusTargetError({ details: { reason: 'focus rejected' } }));
}

// ---------------------------------------------------------------- element

export class SkipLinkEvent extends Event {
  static readonly type = 'sf-skip' as const;
  constructor(
    readonly slot: SlotId,
    readonly result: Result<Element>,
  ) {
    super(SkipLinkEvent.type, { bubbles: true, composed: true });
  }
}

export class SfSkipLinksElement extends LitElement {
  static override properties = {
    links: { attribute: false },
    label: { type: String },
    focusManager: { attribute: false },
    resolve: { attribute: false },
  };
  static override styles = css`
    :host {
      display: contents;
    }
    .links {
      position: absolute;
      inset-block-start: var(--sf-space-2, 8px);
      inset-inline-start: var(--sf-space-2, 8px);
      z-index: var(--sf-z-skip-links, 1000);
      display: flex;
      gap: var(--sf-space-2, 8px);
    }
    a {
      padding: var(--sf-space-2, 8px) var(--sf-space-3, 16px);
      border-radius: var(--sf-radius-small, 4px);
      background: var(--sf-color-accent, #4f46e5);
      color: var(--sf-color-accent-fg, #fff);
      font: inherit;
      text-decoration: underline;
      outline-offset: 2px;
    }
    a:not(:focus) {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `;

  declare links: readonly SkipLink[];
  declare label: string;
  declare focusManager: FocusManager | undefined;
  /** Resolve a slot to its region. Default: `[data-slot=…]` in this element's root (document or shadow root). */
  declare resolve: ((slot: SlotId) => Element | null) | undefined;

  constructor() {
    super();
    this.links = skipLinksFor(['main']);
    this.label = defaultShellMessages.skipLinksLabel;
    this.focusManager = undefined;
    this.resolve = undefined;
  }

  /** Move focus to a slot's region. */
  skipTo(slot: SlotId): Result<Element> {
    const resolve =
      this.resolve ??
      ((s: SlotId) =>
        [...(this.getRootNode() as Document | ShadowRoot).querySelectorAll(`[${SLOT_ATTR}]`)].find((el) => el.getAttribute(SLOT_ATTR) === s) ?? null);
    const result = focusSkipTarget(resolve(slot), this.focusManager);
    this.dispatchEvent(new SkipLinkEvent(slot, result));
    return result;
  }

  override render(): unknown {
    if (this.links.length === 0) return null;
    return html`<div class="links" role="group" aria-label=${this.label}>
      ${this.links.map(
        (link) =>
          html`<a
            href=${`#${link.slot}`}
            data-skip=${link.slot}
            @click=${(event: Event) => {
              event.preventDefault();
              this.skipTo(link.slot);
            }}
            >${link.label}</a
          >`,
      )}
    </div>`;
  }
}

export const SKIP_LINKS_TAG = 'sf-skip-links';

export function defineSkipLinks(registry: CustomElementRegistry = customElements): void {
  if (registry.get(SKIP_LINKS_TAG) === undefined) registry.define(SKIP_LINKS_TAG, SfSkipLinksElement);
}
