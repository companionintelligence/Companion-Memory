import { readFileSync } from 'fs';
import path from 'path';

import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory, Query, Resolver } from '@nestjs/graphql';
import { GraphQLObjectType } from 'graphql';

import {
  ACTIVITY_COUNT_FIELDS,
  ActivityCountsType,
  RETIRED_SOURCE_KEYS,
  SUMMARY_SOURCE_NAMES,
} from '../ActivityCountsType';

/**
 * The Python summary registry, read at test time. There is no build-time link
 * between the sidecar and this schema, so the only way to catch a source being
 * added (or renamed) on the Python side is to parse the file the sidecar
 * actually ships and compare. Before this test, four dead sources sat in the
 * projection and ten live ones had no GraphQL field at all.
 */
const SUMMARY_SOURCES_PY = path.resolve(
  __dirname,
  '../../../../../../summary/src/ci/summary/summary_sources.py',
);

function pythonRegistrySourceNames(): string[] {
  const source = readFileSync(SUMMARY_SOURCES_PY, 'utf8');
  const tupleStart = source.indexOf('SUMMARY_SOURCES: tuple');

  expect(tupleStart).toBeGreaterThan(-1);

  const names: string[] = [];
  const constructor = /SummarySource\(\s*"([a-z0-9_]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = constructor.exec(source.slice(tupleStart))) !== null) {
    names.push(match[1]);
  }

  return names;
}

/**
 * The type as it lands in the published schema. Built through the real Nest
 * schema factory rather than by reading decorator metadata, so the assertions
 * below are about what clients can actually select.
 */
@Resolver()
class ActivityCountsProbeResolver {
  @Query(() => ActivityCountsType)
  activityCountsProbe(): ActivityCountsType {
    return { total: 0 };
  }
}

let activityCountsGraphqlType: GraphQLObjectType;

beforeAll(async () => {
  const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });

  await app.init();

  const schema = await app.get(GraphQLSchemaFactory).create([ActivityCountsProbeResolver]);

  activityCountsGraphqlType = schema.getType('ActivityCountsType') as GraphQLObjectType;

  await app.close();
});

function declaredGraphqlFields(): string[] {
  return Object.keys(activityCountsGraphqlType.getFields());
}

describe('ActivityCountsType tracks the summary source registry', () => {
  it('mirrors every source name the Python registry declares', () => {
    // Fails the moment a SummarySource is added, renamed or removed in
    // summary_sources.py without the matching GraphQL field landing here.
    expect([...SUMMARY_SOURCE_NAMES]).toEqual(pythonRegistrySourceNames());
  });

  it('exposes a GraphQL field for every registry source', () => {
    const fields = declaredGraphqlFields();

    for (const sourceName of SUMMARY_SOURCE_NAMES) {
      expect(fields).toContain(ACTIVITY_COUNT_FIELDS[sourceName]);
    }
  });

  it('keeps the retired sources as published fields rather than deleting them', () => {
    // Removing a field breaks every client still selecting it, so they stay in
    // the schema (deprecated) and keep projecting values from older summaries.
    const fields = activityCountsGraphqlType.getFields();

    for (const retiredKey of RETIRED_SOURCE_KEYS) {
      const field = fields[ACTIVITY_COUNT_FIELDS[retiredKey]];

      expect(field).toBeDefined();
      expect(field.deprecationReason).toBeTruthy();
    }
  });
});

describe('ActivityCountsType.fromContent', () => {
  it('projects a count for every source count_activities can emit', () => {
    const counts: Record<string, number> = { total: SUMMARY_SOURCE_NAMES.length };

    for (const sourceName of SUMMARY_SOURCE_NAMES) {
      counts[sourceName] = 1;
    }

    const projected = ActivityCountsType.fromContent(counts) as unknown as Record<string, number>;

    for (const sourceName of SUMMARY_SOURCE_NAMES) {
      expect(projected[ACTIVITY_COUNT_FIELDS[sourceName]]).toBe(1);
    }

    // The per-source breakdown has to add back up to the total the sidecar
    // computed; a source with no field silently shrinks this sum.
    const breakdown = Object.entries(projected)
      .filter(([key]) => key !== 'total')
      .reduce((sum, [, value]) => sum + value, 0);

    expect(breakdown).toBe(projected.total);
  });

  it('projects the registry key `position`, not the plural `positions`', () => {
    // `positions` was the shape of the original bug: the map keyed on a name
    // the registry has never emitted, so the field was permanently null.
    const projected = ActivityCountsType.fromContent({ total: 4, position: 4 });

    expect(projected.position).toBe(4);
    expect(projected.positions).toBeUndefined();
  });

  it('still projects counts stored under retired source keys', () => {
    const projected = ActivityCountsType.fromContent({ total: 2, screen_captures: 2 });

    expect(projected.screenCaptures).toBe(2);
  });

  it('omits sources with no activity', () => {
    const projected = ActivityCountsType.fromContent({ total: 1, tasks: 1, notes: 0 });

    expect(projected.tasks).toBe(1);
    expect('notes' in projected).toBe(false);
  });
});
