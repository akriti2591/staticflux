// Imported first by every thread fixture: makes later dynamic imports of workspace sources work.
import { register } from 'node:module';

register(new URL('./ts-hooks.mjs', import.meta.url));
