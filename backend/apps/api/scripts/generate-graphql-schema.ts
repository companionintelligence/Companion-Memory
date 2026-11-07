import fs from 'fs';
import path from 'path';

import type { Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { printSchema, lexicographicSortSchema } from 'graphql';

import { GraphQLModule } from '@ci/domains/graphql';
import { JsonObjectScalar } from '@ci/domains/graphql/scalars/JsonObjectScalar';

function scanForResolvers(
  moduleRef: Type<unknown> | object,
  visited = new Set<Type<unknown> | object>(),
): Type<unknown>[] {
  if (visited.has(moduleRef)) {
    return [];
  }

  visited.add(moduleRef);

  const resolvers: Type<unknown>[] = [];
  const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleRef) || []) as Array<
    Type<unknown> | { module: Type<unknown> } | object
  >;
  const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, moduleRef) || [];

  for (const provider of providers) {
    if (typeof provider !== 'function') {
      continue;
    }

    const isResolver =
      Reflect.getMetadata('graphql:resolver_type', provider) || provider.name.endsWith('Resolver');

    if (isResolver) {
      resolvers.push(provider as Type<unknown>);
    }
  }

  for (const importedModule of imports) {
    if (importedModule == null) {
      continue;
    }

    // Nest `forwardRef(() => Mod)` stores `{ forwardRef: () => Mod }` — not a module class.
    if (typeof importedModule === 'object' && 'forwardRef' in importedModule) {
      const resolved = (importedModule as { forwardRef: () => Type<unknown> }).forwardRef();

      if (resolved) {
        resolvers.push(...scanForResolvers(resolved, visited));
      }

      continue;
    }

    const moduleClass =
      typeof importedModule === 'object' && 'module' in importedModule
        ? (importedModule as { module: Type<unknown> }).module
        : (importedModule as Type<unknown>);

    if (moduleClass) {
      resolvers.push(...scanForResolvers(moduleClass, visited));
    }
  }

  return resolvers;
}

async function generateSchema() {
  const resolvers = scanForResolvers(GraphQLModule);

  const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });

  await app.init();

  const schemaFactory = app.get(GraphQLSchemaFactory);
  // The scalar is passed in: the builder's context does not discover `@Scalar` providers, and
  // `answerEvidence` is typed Object, which only the JSONObject scalar maps.
  const schema = await schemaFactory.create(resolvers, [JsonObjectScalar]);
  const sortedSchema = lexicographicSortSchema(schema);
  const schemaAsString = printSchema(sortedSchema);

  const frontMatter = `# ------------------------------------------------------
# THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)
# ------------------------------------------------------

`;

  fs.writeFileSync(
    path.join(__dirname, '..', 'src', 'domains', 'graphql', '__generated__', 'schema.graphql'),
    frontMatter + schemaAsString,
  );

  await app.close();
}

generateSchema();
