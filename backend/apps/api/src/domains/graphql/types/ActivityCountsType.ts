import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * The summary sidecar's source registry, mirrored on the TypeScript side.
 *
 * `count_activities` keys its output by `SummarySource.name`, one entry per
 * registry row, so this list *is* the set of JSON keys the GraphQL projection
 * has to cover. The registry itself lives in Python
 * (`backend/apps/summary/src/ci/summary/summary_sources.py`) and nothing links
 * the two languages at build time, which is how the previous hand-maintained
 * map ended up projecting four sources that no longer exist and missing ten
 * that do. `__tests__/ActivityCountsType.registry.spec.ts` parses that Python
 * file and fails if the two ever drift again — keep the two in the same commit.
 */
export const SUMMARY_SOURCE_NAMES = [
  'position',
  'communications',
  'events',
  'macos_activity',
  'messages',
  'files',
  'content',
  'file_chunks',
  'notes',
  'tasks',
  'browser_activity',
  'objects',
  'object_observations',
  'receipts',
  'receipt_line_items',
  'answers',
  'tool_invocations',
] as const;

/**
 * Keys that older summary rows may still carry from registries this schema has
 * since dropped. They are projected (and exposed as deprecated GraphQL fields)
 * so a summary written before the source list changed keeps rendering the
 * numbers it was written with, rather than silently losing them.
 */
export const RETIRED_SOURCE_KEYS = [
  'screen_captures',
  'api_logs',
  'activities',
  'measurements',
  // 'positions' (plural) never matched any registry entry — the source has
  // always been named 'position'. Kept only so the published field name
  // resolves to something rather than disappearing from the schema.
  'positions',
] as const;

/** `file_chunks` -> `fileChunks`; the registry's snake_case is the JSON key, camelCase is the GraphQL field. */
function toFieldName(sourceKey: string): string {
  return sourceKey.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * JSON key -> GraphQL field name, derived rather than hand-written so adding a
 * registry entry to SUMMARY_SOURCE_NAMES is the only edit needed to project it.
 */
export const ACTIVITY_COUNT_FIELDS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries([...SUMMARY_SOURCE_NAMES, ...RETIRED_SOURCE_KEYS].map((key) => [key, toFieldName(key)])),
);

@ObjectType()
export class ActivityCountsType {
  @Field(() => Int)
  total!: number;

  // One field per SUMMARY_SOURCE_NAMES entry, in registry order.

  @Field(() => Int, { nullable: true })
  position?: number;

  @Field(() => Int, { nullable: true })
  communications?: number;

  @Field(() => Int, { nullable: true })
  events?: number;

  @Field(() => Int, { nullable: true })
  macosActivity?: number;

  @Field(() => Int, { nullable: true })
  messages?: number;

  @Field(() => Int, { nullable: true })
  files?: number;

  @Field(() => Int, { nullable: true })
  content?: number;

  @Field(() => Int, { nullable: true })
  fileChunks?: number;

  @Field(() => Int, { nullable: true })
  notes?: number;

  @Field(() => Int, { nullable: true })
  tasks?: number;

  @Field(() => Int, { nullable: true })
  browserActivity?: number;

  @Field(() => Int, { nullable: true })
  objects?: number;

  @Field(() => Int, { nullable: true })
  objectObservations?: number;

  @Field(() => Int, { nullable: true })
  receipts?: number;

  @Field(() => Int, { nullable: true })
  receiptLineItems?: number;

  @Field(() => Int, { nullable: true })
  answers?: number;

  @Field(() => Int, { nullable: true })
  toolInvocations?: number;

  // Retired sources. Kept in the schema — deleting a published field breaks
  // every client that still selects it — but they only ever carry a value for
  // summaries written while the source still existed.

  @Field(() => Int, {
    nullable: true,
    deprecationReason: 'Retired summary source; only set on summaries written before it was dropped.',
  })
  screenCaptures?: number;

  @Field(() => Int, {
    nullable: true,
    deprecationReason: 'Retired summary source; only set on summaries written before it was dropped.',
  })
  apiLogs?: number;

  @Field(() => Int, {
    nullable: true,
    deprecationReason: 'Retired summary source; only set on summaries written before it was dropped.',
  })
  activities?: number;

  @Field(() => Int, {
    nullable: true,
    deprecationReason: 'Retired summary source; only set on summaries written before it was dropped.',
  })
  measurements?: number;

  @Field(() => Int, {
    nullable: true,
    deprecationReason: 'Never populated — the source has always been named `position`. Use `position`.',
  })
  positions?: number;

  static fromContent(activityCounts: Record<string, unknown> | undefined): ActivityCountsType {
    if (!activityCounts) {
      return { total: 0 };
    }

    // Only include fields with values > 0
    const result: ActivityCountsType = {
      total: Number(activityCounts.total) || 0,
    };

    for (const [jsonKey, fieldName] of Object.entries(ACTIVITY_COUNT_FIELDS)) {
      const value = Number(activityCounts[jsonKey]);
      if (value && value > 0) {
        (result as unknown as Record<string, number>)[fieldName] = value;
      }
    }

    return result;
  }
}
