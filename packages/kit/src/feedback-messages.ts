/**
 * Strings of the kit's dialog frames and feedback blocks (`kit-feedback` catalog): their own module so the small
 * controls do not ship them. Translate with `defineTranslations(feedbackMessages, 'fr', { … })`.
 */
import { defineMessages } from '@staticflux/i18n';

export const feedbackMessages = /* @__PURE__ */ defineMessages('kit-feedback', {
  back: 'Back',
  stepOf: '{step} of {total}',
  discardChanges: 'Discard changes?',
  discard: 'Discard',
  keepEditing: 'Keep editing',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Allow clipboard access in site settings, or select the text and copy it.',
  cancel: 'Cancel',
  tryAgain: 'Try again',
  reload: 'Reload',
  copyDiagnostics: 'Copy diagnostics',
  more: 'More',
});
