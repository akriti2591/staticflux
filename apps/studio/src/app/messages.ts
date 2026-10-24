/**
 * App messages (R14.1). English is the source locale; Arabic (RTL) is a lazy
 * catalog chunk (`locales/ar.ts`), loaded only when the locale switches.
 */
import { catalogLoader, defineMessages } from '@staticflux/i18n';
import { appMessageSource } from './messages-source.js';

export const appMessages = defineMessages(
  'studio/app',
  appMessageSource,

  { sourceLocale: 'en' },
);

export const appCatalogLoader = catalogLoader(appMessages, {
  ar: () => import('../locales/ar.js'),
});

export const AVAILABLE_LOCALES = ['en', 'ar'] as const;
