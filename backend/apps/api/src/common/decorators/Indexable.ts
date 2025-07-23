import 'reflect-metadata';

const INDEXABLE_KEY = Symbol('indexable-metadata');

interface IndexabaleMetadata {
  type: string;
  validPaths: Set<string>;
}

export function Indexable(type: string, validPaths: string[] = []) {
  for (const path of validPaths) {
    if (!isJSPropertyPath(path)) {
      throw new Error(`Invalid property path: ${path}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  return function (target: Function) {
    Reflect.defineMetadata(
      INDEXABLE_KEY,
      {
        type,
        validPaths: new Set(validPaths),
      } satisfies IndexabaleMetadata,
      target,
    );
  };
}

export function getIndexableMetadataFromInstance(obj: object) {
  const constructor = obj.constructor;

  return getIndexableMetadataFromClass(constructor);
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function getIndexableMetadataFromClass(target: Function): IndexabaleMetadata | undefined {
  return Reflect.getMetadata(INDEXABLE_KEY, target);
}

function isJSPropertyPath(str: string): boolean {
  return /^([a-zA-Z_$][a-zA-Z0-9_$]*|\[(?:'[^']*'|"[^"]*"|\d+)\])(\.([a-zA-Z_$][a-zA-Z0-9_$]*|\[(?:'[^']*'|"[^"]*"|\d+)\]))*$/.test(
    str,
  );
}
