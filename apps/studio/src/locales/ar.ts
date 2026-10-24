/** Arabic catalog for the app shell (lazy chunk; RTL locale). */
import { defineTranslations } from '@staticflux/i18n';
import { appMessages } from '../app/messages.js';

export default defineTranslations(appMessages, 'ar', {
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
});
