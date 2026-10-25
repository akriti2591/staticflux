/**
 * Error catalog of @staticflux/ui. Codes are stable; agents look them up
 * (docs/LIFECYCLES.md §12–§13) instead of guessing.
 */
import { defineError } from '@staticflux/core';

/** I-11: render deps are never read before ready. */
export const RenderDepNotReadyError = defineError(
  'SF-UI-001',
  'invariant',
  'A render dependency was read before it was ready (I-11).',
  'Read render deps only inside `render()` (which runs after readiness) or after `this.ready`; use a `lazy` dep for values that may arrive later.',
);

export const NoInjectorError = defineError(
  'SF-UI-002',
  'invariant',
  'A component connected without an injector scope above it in the DOM.',
  'Render the component inside an `<sf-scope>` (the app root passes `.injector`) or call `provideScope(rootElement, …)` first.',
);

export const RenderDepFailedError = defineError(
  'SF-UI-003',
  'unavailable',
  'A render dependency (or a blocking hook) failed, so the component cannot render its content.',
  'Inspect `cause`. Make the dependency `lazy` if the component can render without it, or add a `failed` template to the component spec.',
);

export const ComponentDefinitionError = defineError(
  'SF-UI-004',
  'invariant',
  'A component class was defined without a valid spec (missing `static spec`, invalid tag, or tag already taken by another class).',
  'Declare `static override readonly spec = component({ tag: "x-y", … })` on the class and call `defineComponent(Class)` once.',
);

export const HookFailedError = defineError(
  'SF-UI-005',
  'unavailable',
  'A component dependency hook failed.',
  'Inspect `cause`. Non-blocking hook failures are reported only; blocking ones keep the component in its failed state.',
);

export const RenderFailedError = defineError(
  'SF-UI-006',
  'invariant',
  "A component's render() threw.",
  'render() must be pure: read state, return a template. Move fallible work to hooks or store actions returning Result.',
);

export const ThemeInvalidError = defineError(
  'SF-UI-008',
  'validation',
  'A theme is incomplete or malformed: a token has no value, an unknown token was set, or a value is empty.',
  'Give every token of the token set a value in `values` (the types list them); variants (`dark`, `density`, `contrast`, `reducedMotion`) may only override declared tokens. See `details.issues`.',
);

export const NoThemeError = defineError(
  'SF-UI-009',
  'not-found',
  'The appearance controller has no theme: nothing was contributed to `ThemesToken`, or the requested theme id is not contributed.',
  'Register a theme contribution, e.g. `defaultThemeContribution` from `@staticflux/ui/default-theme`, or `themeContribution(myTheme)`; check the id passed to `useTheme` / `appearanceUnitWith({ theme })`.',
);

export const InvalidColorError = defineError(
  'SF-UI-010',
  'validation',
  'A color value could not be parsed.',
  'Use `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` or `rgb()/rgba()`; contrast checks need concrete sRGB values, not color names or `var()` references.',
);

export const UnknownDepKeyError = defineError(
  'SF-UI-007',
  'invariant',
  'A hook or intent referenced a dependency key the component did not declare.',
  'Use one of the keys declared in `component({ deps })`; the types list them.',
);
