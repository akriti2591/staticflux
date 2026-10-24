/**
 * Island `island:code` — copy-to-clipboard for one code block. Hydrates on first
 * interaction (`hydrate="interaction"`: preloaded on hover/focus, the first click is
 * queued and replayed), so pages with forty code blocks load no copy code up front.
 */
import { anySignal, ok, sleep } from '@staticflux/core';
import { AnnouncerToken } from '@staticflux/a11y';
import { defineIsland } from '@staticflux/hydrate';
import { ClipboardUnavailableError } from '../errors.js';

const codeIsland = defineIsland({
  async hydrate(element, { injector, scope, signal }) {
    const button = element.querySelector<HTMLButtonElement>('[data-copy]');
    const label = element.querySelector<HTMLElement>('[data-copy-label]');
    const source = element.querySelector('pre code');
    if (button === null || source === null) return ok();
    const announcer = injector === undefined ? undefined : await injector.get(AnnouncerToken, signal);
    let reset: AbortController | undefined;

    scope.listen(button, 'click', () => {
      const text = source.textContent ?? '';
      const clipboard = globalThis.navigator?.clipboard;
      const copied = clipboard === undefined ? Promise.reject(ClipboardUnavailableError()) : clipboard.writeText(text);
      void copied.then(
        async () => {
          button.dataset['state'] = 'copied';
          if (label !== null) label.textContent = 'Copied';
          if (announcer?.ok === true) announcer.value.announce('Code copied to clipboard');
          // Reset the label after 2 s — abortable, and aborted with the island scope.
          reset?.abort();
          reset = new AbortController();
          const done = await sleep(2000, anySignal(signal, reset.signal));
          if (!done.ok) return;
          delete button.dataset['state'];
          if (label !== null) label.textContent = 'Copy';
        },
        () => {
          if (label !== null) label.textContent = 'Press Ctrl+C';
          const selection = globalThis.getSelection?.();
          if (selection !== null && selection !== undefined) selection.selectAllChildren(source);
        },
      );
    });
    scope.defer(() => reset?.abort());
    return ok();
  },
});

export const hydrate = codeIsland.hydrate;
