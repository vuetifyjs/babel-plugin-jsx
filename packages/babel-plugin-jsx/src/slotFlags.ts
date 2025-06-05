import * as t from '@babel/types';

// https://github.com/vuejs/core/blob/main/packages/shared/src/slotFlags.ts
const enum SlotFlags {
  /**
   * Stable slots that only reference slot props or context state. The slot
   * can fully capture its own dependencies so when passed down the parent won't
   * need to force the child to update.
   */
  STABLE = 1,
  /**
   * Slots that reference scope variables (v-for or an outer slot prop), or
   * has conditional structure (v-if, v-for). The parent will need to force
   * the child to update because the slot does not fully capture its dependencies.
   */
  DYNAMIC = 2,
  /**
   * `<slot/>` being forwarded into a child component. Whether the parent needs
   * to update the child is dependent on what kind of slots the parent itself
   * received. This has to be refined at runtime, when the child's vnode
   * is being created (in `normalizeChildren`)
   */
  FORWARDED = 3,
}

export default SlotFlags;

export function determineSlotFlags(
  expression: t.ObjectExpression,
  slotFlag: SlotFlags
) {
  let hasDynamicSlots = false;
  let hasForwardedSlots = false;

  for (const property of expression.properties) {
    // { ...slots } (forwarded)
    if (
      t.isSpreadElement(property) &&
      t.isIdentifier(property.argument) &&
      property.argument.name === 'slots'
    ) {
      hasForwardedSlots = true;
      continue;
    }

    // { ...somethingElse } or { [name]: () => {} } (dynamic)
    if (t.isSpreadElement(property) || property.computed) {
      hasDynamicSlots = true;
      break;
    }

    // { name () {} } (stable)
    if (!t.isObjectProperty(property)) continue;

    // { name: slots.foo } (forwarded)
    if (
      t.isMemberExpression(property.value) &&
      t.isIdentifier(property.value.object) &&
      property.value.object.name === 'slots'
    ) {
      hasForwardedSlots = true;
      continue;
    }

    // { name: cond ? a : b }
    if (t.isConditional(property.value)) {
      // { name: slots.foo ? a : b } (forwarded)
      if (
        t.isMemberExpression(property.value.test) &&
        t.isIdentifier(property.value.test.object) &&
        property.value.test.object.name === 'slots'
      ) {
        hasForwardedSlots = true;
        continue;
      }
      hasDynamicSlots = true;
      break;
    }
  }

  return hasDynamicSlots || slotFlag === SlotFlags.DYNAMIC
    ? SlotFlags.DYNAMIC
    : hasForwardedSlots || slotFlag === SlotFlags.FORWARDED
      ? SlotFlags.FORWARDED
      : slotFlag;
}
