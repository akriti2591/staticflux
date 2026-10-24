/** Source (English) texts of the app catalog — plain data, no imports (shared by the lazy locale chunks for key typing). */
export const appMessageSource = {
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
  } as const;

export type AppMessageKey = keyof typeof appMessageSource;
