/** Join truthy class-name fragments into a single `className` string. */
export const join = (...values: Array<string | false | null | undefined>): string => values.filter(Boolean).join(" ");
