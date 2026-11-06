export type JsonObject = Record<string, unknown>;

/** An object literal or `JSON.parse` result: not an array, a class instance, a Map or a Date. */
export function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/** Whether a JSON-LD `type` value, a string or an array of strings, names `name`. */
export function hasType(type: unknown, name: string): boolean {
  return type === name || (Array.isArray(type) && type.includes(name));
}
