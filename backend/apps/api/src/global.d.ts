declare global {
  /**
   * Make a set of properties optional in a type.
   *
   * @example
   * type User = { id: string; name: string; email: string };
   * type UpdateUser = Optional<User, 'email'>; // { id: string; name: string; email?: string }
   */
  type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

  /**
   * Make a set of properties required in a type.
   *
   * @example
   * type User = { id?: string | null; name?: string; email: string }
   * type CompleteUser = RequiredFields<User, 'id' | 'name'>;
   * // { id: string; name: string; email: string }
   *
   * // Pass `false` to keep nullable types:
   * type NullableUser = RequiredFields<User, 'id', false>;
   * // { id: string | null; name?: string; email: string }
   */
  export type RequiredFields<T, K extends keyof T, NonNullableFields extends boolean = false> = Omit<T, K> & {
    [P in K]-?: NonNullableFields extends true ? NonNullable<T[P]> : T[P];
  };
}

export {};
