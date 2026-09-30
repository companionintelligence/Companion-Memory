import type { JSONSchema } from './types';

/**
 * Bring a model's tool arguments to the types the tool's schema declares, where the value is a
 * string that unambiguously spells one of them.
 *
 * Models do not always send JSON-typed arguments. A tool call salvaged from Qwen's XML markup
 * (`<parameter=maxResults>15</parameter>`) carries every value as text, and an engine parsing that
 * markup itself (llama.cpp, vLLM's parsers) types them only when it reads the schema — measured
 * 2026-09-30 on Lemonade: `media_findPhotos` got `maxResults: "15"`, Zod refused it, the model
 * apologised and sent the same call again, and the turn burned its tool rounds on a type error no
 * one made. This runs before validation, so a `"15"` for an integer is `15` and a `"true"` for a
 * boolean is `true`; a `"15"` for a string stays a string, and a value the schema does not name a
 * scalar type for is left alone. Nothing here is lossy: a string that does not spell the declared
 * type — `"fifteen"`, `"1.5"` for an integer — is passed through for the validator to refuse with
 * its own message.
 */
export function coerceArgumentsToSchema(input: unknown, schema: JSONSchema | undefined): unknown {
  if (schema == null) {
    return input;
  }

  const types = declaredTypes(schema);

  if (typeof input === 'string') {
    return coerceString(input, types, schema);
  }

  if (Array.isArray(input)) {
    return schema.items && types.has('array')
      ? input.map((item) => coerceArgumentsToSchema(item, schema.items))
      : input;
  }

  if (input != null && typeof input === 'object' && schema.properties && types.has('object')) {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = coerceArgumentsToSchema(value, schema.properties[key]);
    }

    return out;
  }

  return input;
}

/** Every scalar/structural type the schema admits, through `type` and any `anyOf` branches. */
function declaredTypes(schema: JSONSchema): Set<string> {
  const types = new Set<string>();

  if (typeof schema.type === 'string') {
    types.add(schema.type);
  }

  for (const branch of schema.anyOf ?? []) {
    for (const type of declaredTypes(branch)) {
      types.add(type);
    }
  }

  // A schema that gives no type but does describe properties or items is an object or array.
  if (types.size === 0) {
    if (schema.properties) {
      types.add('object');
    }

    if (schema.items) {
      types.add('array');
    }
  }

  return types;
}

function coerceString(value: string, types: Set<string>, schema: JSONSchema): unknown {
  // A string the schema allows is already right; never reinterpret it.
  if (types.has('string') || types.size === 0) {
    return value;
  }

  const trimmed = value.trim();

  if (types.has('integer') && /^[+-]?\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);

    return Number.isSafeInteger(parsed) ? parsed : value;
  }

  if (types.has('number') && trimmed !== '' && Number.isFinite(Number(trimmed))) {
    return Number(trimmed);
  }

  if (types.has('boolean') && (trimmed === 'true' || trimmed === 'false')) {
    return trimmed === 'true';
  }

  if (types.has('null') && trimmed === 'null') {
    return null;
  }

  if ((types.has('array') && trimmed.startsWith('[')) || (types.has('object') && trimmed.startsWith('{'))) {
    try {
      return coerceArgumentsToSchema(JSON.parse(trimmed), schema);
    } catch {
      return value;
    }
  }

  return value;
}
