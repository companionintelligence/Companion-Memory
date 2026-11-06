import { Scalar, type CustomScalar } from '@nestjs/graphql';
import { Kind, print, type ObjectValueNode, type ValueNode } from 'graphql';

type JsonObject = Record<string, unknown>;

/**
 * The type a JSON-object field declares. NestJS maps `Object` to the `JSONObject`
 * scalar through the `@Scalar` typeFn below; a scalar class is not a valid field type.
 */
export const GraphQLJSONObject = Object;

/**
 * `JSONObject`: an arbitrary JSON object. Same contract as graphql-type-json's
 * `GraphQLJSONObject`, which this replaces.
 *
 * Declared as a decorated NestJS scalar class rather than imported as an instance.
 * graphql-type-json builds its scalar with the CommonJS build of `graphql`, while
 * NestJS loads the ESM build, so NestJS's `instanceof GraphQLScalarType` check
 * rejects the instance ("Cannot determine a GraphQL output type"). A class is
 * resolved by its decorator metadata and needs no such check.
 */
@Scalar('JSONObject', () => Object)
export class JsonObjectScalar implements CustomScalar<JsonObject, JsonObject> {
  description =
    'The `JSONObject` scalar type represents JSON objects as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf).';

  serialize(value: unknown): JsonObject {
    return ensureObject(value);
  }

  parseValue(value: unknown): JsonObject {
    return ensureObject(value);
  }

  parseLiteral(ast: ValueNode, variables?: Record<string, unknown> | null): JsonObject {
    if (ast.kind !== Kind.OBJECT) {
      throw new TypeError(`JSONObject cannot represent non-object value: ${print(ast)}`);
    }

    return parseObject('JSONObject', ast, variables);
  }
}

function ensureObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`JSONObject cannot represent non-object value: ${String(value)}`);
  }

  return value as JsonObject;
}

function parseObject(
  typeName: string,
  ast: ObjectValueNode,
  variables?: Record<string, unknown> | null,
): JsonObject {
  const value: JsonObject = Object.create(null);

  for (const field of ast.fields) {
    value[field.name.value] = parseLiteral(typeName, field.value, variables);
  }

  return value;
}

function parseLiteral(typeName: string, ast: ValueNode, variables?: Record<string, unknown> | null): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return parseFloat(ast.value);
    case Kind.OBJECT:
      return parseObject(typeName, ast, variables);
    case Kind.LIST:
      return ast.values.map((node) => parseLiteral(typeName, node, variables));
    case Kind.NULL:
      return null;
    case Kind.VARIABLE:
      return variables ? variables[ast.name.value] : undefined;
    default:
      throw new TypeError(`${typeName} cannot represent value: ${print(ast)}`);
  }
}
