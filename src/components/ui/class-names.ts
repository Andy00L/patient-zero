/**
 * Joins class name fragments and drops anything falsy.
 *
 * Deliberately not a Tailwind class merger: the primitives in this folder never emit two
 * competing utilities for the same CSS property, so conflict resolution would be dead
 * weight. A caller's own `className` is always appended last, so where it does overlap it
 * wins by source order.
 */
export function joinClassNames(
  ...fragments: readonly (string | false | null | undefined)[]
): string {
  return fragments.filter((fragment): fragment is string => Boolean(fragment)).join(" ");
}
