/**
 * `true` when A and B are the same type, field for field (optional ones too), else `false`. A schema and the interface
 * it describes are checked with `true satisfies Same<Static<typeof XSchema>, X>;`, which fails to compile when either
 * gains, loses or changes a field.
 */
export type Same<A, B> = (<T>() => T extends Deep<A> ? 1 : 2) extends <T>() => T extends Deep<B> ? 1 : 2 ? true : false;

/** Flattens interfaces, intersections and `extends` into plain object types, all the way down, so only shape counts. */
type Deep<T> = T extends (infer U)[] ? Deep<U>[] : T extends object ? { [K in keyof T]: Deep<T[K]> } : T;
