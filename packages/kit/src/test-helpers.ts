/** Test helpers for kit component tests (not exported). */
import type { Registration } from '@staticflux/core';
import { type MountedRoot, mountTestRoot, settle } from '@staticflux/ui/testing';
import { render, type TemplateResult } from 'lit';

export { settle };

let current: MountedRoot | undefined;

/** Render `template` inside a test injector scope and wait for the components to render. */
export async function fixture<E extends Element = HTMLElement>(template: TemplateResult, options: { readonly units?: readonly Registration[] } = {}): Promise<{ readonly element: E; readonly root: MountedRoot }> {
  current = mountTestRoot({ units: options.units ?? [] });
  render(template, current.container);
  await settle();
  return { element: current.container.firstElementChild as E, root: current };
}

export async function cleanup(): Promise<void> {
  await current?.dispose();
  current = undefined;
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('dir');
}

/** Query inside an element's shadow root. */
export function shadow<E extends Element = HTMLElement>(host: Element, selector: string): E {
  const found = host.shadowRoot?.querySelector<E>(selector);
  if (found === null || found === undefined) throw new Error(`${host.localName}: no "${selector}" in shadow root`);
  return found;
}

export function shadowAll<E extends Element = HTMLElement>(host: Element, selector: string): E[] {
  return [...(host.shadowRoot?.querySelectorAll<E>(selector) ?? [])];
}

/** Collect CustomEvents of `type` dispatched on `target`. */
export function events<D = unknown>(target: EventTarget, type: string): CustomEvent<D>[] {
  const seen: CustomEvent<D>[] = [];
  // Test-only listener: lives as long as the fixture's element.
  target.addEventListener(type, (e) => seen.push(e as CustomEvent<D>), { signal: new AbortController().signal });
  return seen;
}
