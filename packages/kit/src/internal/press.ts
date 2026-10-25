/**
 * Button behaviour for host-as-control elements (WAI-ARIA APG Button): `role="button"`
 * on the host, in the tab order unless disabled, Enter activates on keydown and Space on
 * keyup, disabled swallows clicks (`aria-disabled`, kept discoverable), `aria-pressed` for
 * toggle buttons, and form submit/reset through ElementInternals (or the closest form).
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';

export interface Pressable extends HTMLElement, ReactiveControllerHost {
  disabled: boolean;
  /** Toggle state; `undefined` = not a toggle button. */
  pressed: boolean | undefined;
  type: 'button' | 'submit' | 'reset';
}

export class PressController implements ReactiveController {
  private connection: AbortController | undefined;
  private spaceDown = false;
  private readonly internals: ElementInternals | undefined;

  constructor(private readonly host: Pressable) {
    host.addController(this);
    // ElementInternals gives form association; not every DOM implementation has it.
    this.internals = typeof host.attachInternals === 'function' ? host.attachInternals() : undefined;
  }

  hostConnected(): void {
    const host = this.host;
    if (!host.hasAttribute('role')) host.setAttribute('role', 'button');
    this.connection = new AbortController();
    const { signal } = this.connection;
    host.addEventListener(
      'click',
      (event) => {
        if (host.disabled) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        this.submit();
      },
      { capture: true, signal },
    );
    host.addEventListener(
      'keydown',
      (event) => {
        if (event.target !== host || host.disabled) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          host.click();
        } else if (event.key === ' ') {
          event.preventDefault(); // no page scroll; activates on keyup
          this.spaceDown = true;
        }
      },
      { signal },
    );
    host.addEventListener(
      'keyup',
      (event) => {
        // Only a Space pressed *on this button* activates it (focus may have moved here mid-press).
        if (event.target === host && event.key === ' ' && this.spaceDown && !host.disabled) host.click();
        if (event.key === ' ') this.spaceDown = false;
      },
      { signal },
    );
    host.addEventListener('blur', () => (this.spaceDown = false), { signal });
  }

  hostDisconnected(): void {
    this.connection?.abort();
  }

  hostUpdated(): void {
    const host = this.host;
    // A roving parent (toolbar) owns tabindex once it set one; otherwise we do.
    if (!host.hasAttribute('data-roving')) host.setAttribute('tabindex', host.disabled ? '-1' : '0');
    if (host.disabled) host.setAttribute('aria-disabled', 'true');
    else host.removeAttribute('aria-disabled');
    if (host.pressed === undefined) host.removeAttribute('aria-pressed');
    else host.setAttribute('aria-pressed', host.pressed ? 'true' : 'false');
  }

  private submit(): void {
    const type = this.host.type;
    if (type === 'button') return;
    const form = this.internals?.form ?? this.host.closest('form');
    if (form === null || form === undefined) return;
    if (type === 'submit') form.requestSubmit();
    else form.reset();
  }
}
