/** Home's injection tokens (C0). */
import { token } from '@staticflux/core';
import type { HomeModel } from './model.js';

/** The Home model `<if-home>` renders (provided by the Home boot). */
export const HomeModelToken = /* @__PURE__ */ token('instaflow/home-model').type<HomeModel>();
