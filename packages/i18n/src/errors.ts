import { defineError } from '@staticflux/core';

export { MessageSyntaxError } from './icu.js';

export const MissingParamError = defineError(
  'SF-I18N-002',
  'validation',
  'A message was formatted without one of its placeholders.',
  'Pass every placeholder the message uses; the params type of `t(ref, params)` lists them.',
);

export const CatalogLoadError = defineError(
  'SF-I18N-003',
  'network',
  'A locale catalog failed to load.',
  'Check the catalog loader for this namespace/locale (chunk URL, network). The source-locale text is shown meanwhile.',
);

export const UnsupportedLocaleError = defineError(
  'SF-I18N-004',
  'validation',
  'The requested locale is not a valid BCP 47 tag.',
  'Pass a well-formed tag such as `fr`, `pt-BR` or `zh-Hant-TW`.',
);
