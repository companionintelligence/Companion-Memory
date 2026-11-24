import { applyDecorators } from '@nestjs/common';
import { Extensions } from '@nestjs/graphql';

import { FULL_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { GRAPHQL_PRIVACY_EXTENSION, type IntentPrivacy, removesData } from '@ci/domains/tools';

/**
 * Declare what a GraphQL root field actually DOES, for the capability gate on
 * BOTH planes that reach it: MCP and `/graphql` itself.
 *
 * Every root Query and Mutation is auto-wrapped as an MCP tool by
 * `GraphQLToolAdapter`, and each wrapped tool needs an {@link IntentPrivacy}
 * label because `capabilityAllows` reads it: `destructive` (or `access:'delete'`)
 * is what makes a tool require `full` rather than `write`.
 *
 * The same label now prices the field on `/graphql`. A label that loses data
 * also stamps `@RequireCapability(full)` on the resolver method, which
 * `enforceApiKeyCapability` reads through the reflector exactly as it reads the
 * REST declarations. Before that, the label existed only on the schema
 * extension, so a `write` key that MCP refused `deleteNote` could POST the same
 * mutation to `/graphql` and the guard, pricing every mutation at `write` by
 * shape, let it through. One decorator writing both keeps the two planes from
 * disagreeing again: there is no second annotation to forget.
 *
 * Those labels were derived purely from the field NAME — a mutation counted as
 * destructive only if it started with delete/remove/destroy/purge/drop. That is
 * unreliable in both directions, and the failures are not hypothetical:
 *
 * - `returnEventToSlate` ends in `eventService.remove`, and its own SDL
 *   description says "deleting the event it minted" — yet it was labelled a
 *   plain `write`. A `write` key was refused `deleteEvent` and permitted to
 *   delete the same row through this field instead.
 * - `mergePeople` tombstones every source record and deletes their search rows,
 *   with no unmerge in the schema. One call retired an unbounded number of
 *   people, at `write`.
 * - `untagEntities` deletes join rows across ten thousand entities at `write`,
 *   while `deleteTag` — one label — required `full`.
 *
 * A longer verb list does not fix this: the deletion is usually one or two hops
 * down in a service, and a name-based rule cannot see it. `forageReset` reads
 * like a wipe and writes nothing. So the name heuristic stays only as the
 * fallback for undeclared fields, and anything whose true behaviour differs
 * says so here.
 *
 * Implemented over `@Extensions` rather than a plain method decorator on
 * purpose: the adapter only ever sees the built `GraphQLSchema`, never the
 * resolver class, so Reflect metadata would be unreachable. `GraphQLField.extensions`
 * is the one channel that survives schema construction. The guard, which runs
 * on the resolver method, reads the Reflect half.
 *
 * A label that does not lose data adds nothing for the guard: the shape rule
 * already prices a mutation at `write` and a query at `read`.
 *
 * @example
 * ```ts
 * @Mutation(() => Boolean, { description: 'Return a placed event to the slate.' })
 * @GraphqlPrivacy({ access: 'delete', destructive: true })
 * async returnEventToSlate(...) {}
 * ```
 */
export function GraphqlPrivacy(privacy: Partial<IntentPrivacy>): MethodDecorator {
  const label = Extensions({ [GRAPHQL_PRIVACY_EXTENSION]: privacy });

  if (removesData({ access: privacy.access ?? 'write', destructive: privacy.destructive ?? false })) {
    return applyDecorators(label, RequireCapability(FULL_CAPABILITY));
  }

  return label;
}
