/**
 * `defineComponent(Class)` — register a component class under its spec's tag
 * (no decorators: works without `experimentalDecorators`, R2.14). Also registers
 * the framework elements components rely on (`<sf-scope>`, `<sf-skeleton>`).
 */
import { err, ok, type Result } from '@staticflux/core';
import { ComponentDefinitionError } from './errors.js';
import type { SfElement } from './element.js';
import { defineScopeElement } from './scope.js';
import { defineSkeletonElement } from './skeleton.js';

const TAG = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;

export type SfElementClass = (new () => SfElement) & { readonly spec: typeof SfElement.spec };

export function defineComponent(
  elementClass: SfElementClass,
  registry: CustomElementRegistry = customElements,
): Result<void> {
  const spec = elementClass.spec;
  if (spec === undefined || spec.kind !== 'component' || spec.tag === 'sf-anonymous' || !TAG.test(spec.tag)) {
    return err(
      ComponentDefinitionError({
        message: `defineComponent(${elementClass.name}): missing or invalid \`static spec\` (tag "${spec?.tag ?? ''}").`,
        details: { class: elementClass.name },
      }),
    );
  }
  defineUiElements(registry);
  const existing = registry.get(spec.tag);
  if (existing === elementClass) return ok();
  if (existing !== undefined) {
    return err(
      ComponentDefinitionError({
        message: `Tag "${spec.tag}" is already defined by another class.`,
        details: { tag: spec.tag, class: elementClass.name },
      }),
    );
  }
  registry.define(spec.tag, elementClass);
  return ok();
}

/** Register `<sf-scope>` and `<sf-skeleton>` (idempotent). */
export function defineUiElements(registry: CustomElementRegistry = customElements): void {
  defineScopeElement(registry);
  defineSkeletonElement(registry);
}
