/**
 * App messages (R14.1). English is the source locale; Arabic (RTL) is a lazy
 * catalog chunk (`locales/ar.ts`), loaded only when the locale switches.
 */
import { catalogLoader, defineMessages } from '@staticflux/i18n';

export const appMessages = defineMessages(
  'studio/app',
  {
    title: 'Studio',
    home: 'Documents',
    welcome: 'Welcome to Studio',
    guestIntro: 'Sign in to open your documents, or start the tour.',
    signIn: 'Sign in',
    signOut: 'Sign out',
    startTour: 'Start the tour',
    settings: 'Settings',
    credits: '{count, plural, =0 {No credits} one {# credit} other {# credits}}',
    saved: 'Saved',
    openChat: 'Assistant',
    notFound: 'Page not found',
    loadMore: 'Load more',
    signInAs: 'Continue as {name}',
  },
  { sourceLocale: 'en' },
);

export const appCatalogLoader = catalogLoader(appMessages, {
  ar: () => import('../locales/ar.js'),
});

export const AVAILABLE_LOCALES = ['en', 'ar'] as const;
