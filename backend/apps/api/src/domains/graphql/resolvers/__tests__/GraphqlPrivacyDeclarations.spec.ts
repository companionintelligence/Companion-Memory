import { readdirSync, readFileSync } from 'fs';
import path from 'path';

import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import type { GraphQLSchema } from 'graphql';

import { GRAPHQL_PRIVACY_EXTENSION, type IntentPrivacy } from '@ci/domains/tools';

import { PersonResolver } from '../PersonResolver';
import { ScheduleCandidateResolver } from '../ScheduleCandidateResolver';
import { TaskResolver } from '../TaskResolver';

/**
 * Two complementary checks that every GraphQL mutation in this domain carries an explicit,
 * reviewed `@GraphqlPrivacy` declaration rather than relying on `GraphQLToolAdapter`'s name-prefix
 * fallback:
 *
 * 1. A STATIC, same-domain source scan (no schema build) — the fast net that fails in a plain
 *    `yarn jest` run the moment a new `@Mutation` lands with no `@GraphqlPrivacy` above it.
 * 2. A handful of SCHEMA-level checks, built through the real `GraphQLSchemaFactory` (the same
 *    mechanism Nest's `GraphQLModule` uses at boot) against the actual resolvers this bug was
 *    filed about, proving the three originally-flagged mutations — and one more found during this
 *    audit — now report `destructive: true`, and that a previously-correct case is unchanged.
 *
 * Deliberately placed HERE, in `domains/graphql`, rather than beside `GraphQLToolAdapter` in
 * `domains/mcp`: this file imports `TaskResolver`/`PersonResolver`/`ScheduleCandidateResolver`
 * directly, which `no-cross-domain-internals` (`.dependency-cruiser.mjs`) only allows from within
 * their own domain — the same constraint that is WHY `GraphQLToolAdapter` itself only ever reads
 * the built `GraphQLSchema` and never imports a resolver class (see the class doc on
 * `synthesizePrivacy`). `GraphQLToolAdapter`'s own boot-time completeness guard
 * (`assertAllMutationsDeclared`) is covered by its own tests in `GraphQLToolAdapter.spec.ts`.
 */

const RESOLVERS_DIR = path.resolve(__dirname, '..');

/**
 * Every `<File>.ts:<mutationName>` pair for a `@Mutation` method with no `@GraphqlPrivacy`
 * immediately above it (comments in between are fine — only the two decorators are tracked).
 * Mirrors the audit ledger used to close this file's original gap; kept as a permanent test so
 * the gap cannot reopen silently.
 */
function mutationsWithoutDeclaration(): string[] {
  const missing: string[] = [];

  for (const fileName of readdirSync(RESOLVERS_DIR)) {
    if (!fileName.endsWith('.ts') || fileName.endsWith('.spec.ts') || fileName.endsWith('.test.ts')) {
      continue;
    }

    const source = readFileSync(path.join(RESOLVERS_DIR, fileName), 'utf8');
    let hasPrivacy = false;
    let pendingMutation = false;

    for (const line of source.split('\n')) {
      if (line.includes('@GraphqlPrivacy(')) {
        hasPrivacy = true;
        continue;
      }

      if (line.includes('@Mutation(')) {
        pendingMutation = true;
        continue;
      }

      if (!pendingMutation) {
        continue;
      }

      const match = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*\(/.exec(line);

      if (match) {
        if (!hasPrivacy) {
          missing.push(`${fileName}:${match[1]}`);
        }

        pendingMutation = false;
        hasPrivacy = false;
      }
    }
  }

  return missing;
}

describe('every GraphQL mutation declares @GraphqlPrivacy', () => {
  it('has zero mutations left on the inferred-only path', () => {
    expect(mutationsWithoutDeclaration()).toEqual([]);
  });
});

describe('the three originally-flagged mutations, against the real resolvers', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });

    await app.init();

    schema = await app
      .get(GraphQLSchemaFactory)
      .create([TaskResolver, ScheduleCandidateResolver, PersonResolver]);

    await app.close();
  });

  function declaredPrivacy(mutationName: string): Partial<IntentPrivacy> {
    const field = schema.getMutationType()?.getFields()[mutationName];

    if (!field) {
      throw new Error(`mutation not found in schema: ${mutationName}`);
    }

    const declared = field.extensions?.[GRAPHQL_PRIVACY_EXTENSION] as Partial<IntentPrivacy> | undefined;

    if (!declared) {
      throw new Error(`mutation ${mutationName} has no @GraphqlPrivacy declaration`);
    }

    return declared;
  }

  it('unscheduleTask (TaskResolver) declares destructive: true', () => {
    // Was `write`/`destructive: false` under name-inference alone — "unschedule" matches none of
    // DESTRUCTIVE_MUTATION_PREFIXES — even though it deletes the planned block row.
    expect(declaredPrivacy('unscheduleTask')).toMatchObject({ access: 'delete', destructive: true });
  });

  it('returnEventToSlate (ScheduleCandidateResolver) declares destructive: true', () => {
    // Was `write`/`destructive: false` under name-inference alone, despite ending in
    // eventService.remove — the bug's own headline example.
    expect(declaredPrivacy('returnEventToSlate')).toMatchObject({ access: 'delete', destructive: true });
  });

  it('mergePeople (PersonResolver) declares destructive: true', () => {
    // Was `write`/`destructive: false` under name-inference alone — "merge" matches none of the
    // destructive prefixes, despite tombstoning every source person.
    expect(declaredPrivacy('mergePeople')).toMatchObject({ access: 'delete', destructive: true });
  });

  it('planTask (TaskResolver) also declares destructive: true — found during this audit', () => {
    // Not one of the three originally named, but the same bug shape: its own description says
    // "remove any calendar block", and PlannedBlockService.planAsUnscheduled deletes the planned
    // block row exactly like unscheduleTask does. Named like a constructive "accept into backlog"
    // action, so name-inference would have missed it too.
    expect(declaredPrivacy('planTask')).toMatchObject({ access: 'delete', destructive: true });
  });

  it('a previously-correct case — createTask — still declares destructive: false unchanged', () => {
    // The precision-fix requirement: a plain create that name-inference already got right must
    // keep reporting exactly the same thing now that it is explicitly declared instead of guessed.
    expect(declaredPrivacy('createTask')).toMatchObject({ destructive: false });
  });

  it('another previously-correct case — deleteTask — still declares destructive: true unchanged', () => {
    // A plain `delete*` mutation name-inference already got right for the right reason (a real
    // hard delete), now explicitly declared instead of guessed — same outcome either way.
    expect(declaredPrivacy('deleteTask')).toMatchObject({ access: 'delete', destructive: true });
  });
});
