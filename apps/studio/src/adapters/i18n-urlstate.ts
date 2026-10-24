/**
 * Adapter: @staticflux/i18n ⇄ @staticflux/urlstate. `?lang=` is a sticky URL param
 * bound to the runtime locale (switching loads the lazy catalog first, R14.3), and
 * the document root gets `lang`/`dir` (RTL for Arabic).
 */
import { contribution } from '@staticflux/core';
import { bindDocumentLocale, I18nToken } from '@staticflux/i18n';
import { defineSubsystem, SubsystemsToken } from '@staticflux/runtime';
import { UrlSyncToken } from '@staticflux/urlstate';
import { LangBinding } from '../app/contracts.js';

export const localeUrlSubsystemUnit = contribution({
  id: 'studio/locale-url-subsystem-unit',
  provides: SubsystemsToken,
  scope: 'app',
  deps: { required: { i18n: I18nToken, sync: UrlSyncToken } },
  create: ({ i18n, sync }) =>
    defineSubsystem({
      id: 'i18n/locale-url',
      start: (ctx) => {
        const root = (globalThis as { document?: Document }).document?.documentElement;
        bindDocumentLocale(i18n, root, ctx.scope);
        const bound = sync.bind(
          LangBinding,
          {
            get: () => (i18n.locale === i18n.defaultLocale ? undefined : i18n.locale),
            set: (value) => void i18n.setLocale(value ?? i18n.defaultLocale, ctx.signal),
          },
          ctx.scope,
        );
        return bound.ok ? undefined : bound;
      },
      description: 'Sticky ?lang= ⇄ i18n locale; <html lang dir>.',
    }),
});
