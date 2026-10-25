/** Kit events: bubbling, composed CustomEvents. */

/** Dispatch a bubbling, composed CustomEvent; returns false if a listener cancelled it. */
export function emit<D>(target: EventTarget, type: string, detail: D, options: { readonly cancelable?: boolean } = {}): boolean {
  return target.dispatchEvent(new CustomEvent<D>(type, { detail, bubbles: true, composed: true, cancelable: options.cancelable ?? false }));
}
