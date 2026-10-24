/** Arabic catalog for the app shell (lazy chunk; RTL locale). */
import type { TranslationBundle } from '@staticflux/i18n';
import type { AppMessageKey } from '../app/messages-source.js';

// No runtime import of the catalog module (it imports this chunk lazily): keys are checked by type.
const messages: Readonly<Record<AppMessageKey, string>> = {
  title: 'ستوديو',
  home: 'المستندات',
  welcome: 'مرحبًا بك في ستوديو',
  guestIntro: 'سجّل الدخول لفتح مستنداتك، أو ابدأ الجولة.',
  signIn: 'تسجيل الدخول',
  signOut: 'تسجيل الخروج',
  startTour: 'ابدأ الجولة',
  settings: 'الإعدادات',
  credits: '{count, plural, =0 {لا رصيد} one {رصيد واحد} other {# رصيد}}',
  saved: 'تم الحفظ',
  openChat: 'المساعد',
  notFound: 'الصفحة غير موجودة',
  loadMore: 'تحميل المزيد',
  signInAs: 'المتابعة باسم {name}',
};

const bundle: TranslationBundle<'studio/app'> = { kind: 'translations', namespace: 'studio/app', locale: 'ar', messages };
export default bundle;
