import type { GraphNodeEntity, RelationshipEntity } from '@ci/domains/memory';

import { CI, DCTERMS, RDFS, RDF_TYPE, SCHEMA, XSD, isNamedNode, type Quad } from '../../rdf';
import { EntityProjectionService } from '../EntityProjectionService';
import { WebIdService } from '../WebIdService';

/**
 * The projection is the core of the data facade — it turns a private
 * property-graph row into RDF another Solid app can read. These tests pin the
 * mapping contract: lossless `ci:` types/props, schema.org synonyms, typed
 * literals, relationship IRIs, and the deliberate skipping of non-scalars.
 */
const ORIGIN = 'https://ci.example';
const USER = 'user-1';
const ENTITY = '0190bd3e-0000-7000-8000-0000000000aa';
const OTHER = '0190bd3e-0000-7000-8000-0000000000bb';
const SUBJECT = `https://ci.example/solid/storage/${USER}/entity/${ENTITY}`;

const service = new EntityProjectionService(new WebIdService());

const node = (overrides: Partial<GraphNodeEntity> = {}): GraphNodeEntity =>
  ({
    entity_id: ENTITY,
    entity_type: 'Person',
    name: 'Ada Lovelace',
    description: 'Mathematician',
    properties: {},
    created_at: new Date('2020-01-01T00:00:00.000Z'),
    updated_at: new Date('2020-02-02T00:00:00.000Z'),
    owner_user_id: USER,
    ...overrides,
  }) as GraphNodeEntity;

const rel = (overrides: Partial<RelationshipEntity> = {}): RelationshipEntity =>
  ({
    relationship_id: 'r1',
    from_entity_id: ENTITY,
    to_entity_id: OTHER,
    relationship_type: 'knows',
    owner_user_id: USER,
    ...overrides,
  }) as RelationshipEntity;

const objects = (quads: Quad[], predicate: string): string[] =>
  quads
    .filter((q) => q.subject.value === SUBJECT && q.predicate.value === predicate)
    .map((q) => q.object.value);

describe('EntityProjectionService.build', () => {
  it('emits both the lossless ci: type and the schema.org synonym', () => {
    const quads = service.build(node(), [], ORIGIN, USER);
    expect(objects(quads, RDF_TYPE)).toEqual([CI('Person'), SCHEMA('Person')]);
  });

  it('emits only the ci: type for an entity type with no schema.org mapping', () => {
    const quads = service.build(node({ entity_type: 'Concept' }), [], ORIGIN, USER);
    expect(objects(quads, RDF_TYPE)).toEqual([CI('Concept')]);
  });

  it('maps name/description and timestamps', () => {
    const quads = service.build(node(), [], ORIGIN, USER);
    expect(objects(quads, RDFS('label'))).toEqual(['Ada Lovelace']);
    expect(objects(quads, RDFS('comment'))).toEqual(['Mathematician']);
    expect(objects(quads, DCTERMS('created'))).toEqual(['2020-01-01T00:00:00.000Z']);
    expect(objects(quads, DCTERMS('modified'))).toEqual(['2020-02-02T00:00:00.000Z']);
  });

  it('projects scalar properties as typed literals and skips non-scalars', () => {
    const quads = service.build(
      node({
        properties: {
          nickname: 'Countess',
          born: 1815,
          ratio: 1.5,
          active: true,
          missing: null,
          aliases: ['AAL'],
          address: { city: 'London' },
        },
      }),
      [],
      ORIGIN,
      USER,
    );

    expect(objects(quads, CI('nickname'))).toEqual(['Countess']);
    const born = quads.find((q) => q.predicate.value === CI('born'))!;
    expect(born.object).toMatchObject({ value: '1815', datatype: XSD('integer') });
    const ratio = quads.find((q) => q.predicate.value === CI('ratio'))!;
    expect(ratio.object).toMatchObject({ value: '1.5', datatype: XSD('double') });
    const active = quads.find((q) => q.predicate.value === CI('active'))!;
    expect(active.object).toMatchObject({ value: 'true', datatype: XSD('boolean') });

    // null, array, and object values are deliberately not projected.
    expect(quads.some((q) => q.predicate.value === CI('missing'))).toBe(false);
    expect(quads.some((q) => q.predicate.value === CI('aliases'))).toBe(false);
    expect(quads.some((q) => q.predicate.value === CI('address'))).toBe(false);
  });

  it('projects an outbound relationship as an IRI to the other entity resource', () => {
    const quads = service.build(node(), [rel()], ORIGIN, USER);
    const knows = quads.find((q) => q.predicate.value === CI('rel/knows'))!;
    expect(knows).toBeDefined();
    expect(isNamedNode(knows.object)).toBe(true);
    expect(knows.object.value).toBe(`https://ci.example/solid/storage/${USER}/entity/${OTHER}`);
  });

  it('encodes free-text relationship types into a valid predicate IRI', () => {
    const quads = service.build(node(), [rel({ relationship_type: 'works at' })], ORIGIN, USER);
    expect(quads.some((q) => q.predicate.value === CI('rel/works%20at'))).toBe(true);
  });

  it('sanitizes a free-text entity type into a Turtle-safe ci: local name', () => {
    const quads = service.build(node({ entity_type: '2 weird/type' }), [], ORIGIN, USER);
    // Space and slash become `_`; the leading digit is stripped (the following
    // `_` is a valid PN_LOCAL start, so it stays).
    expect(objects(quads, RDF_TYPE)).toEqual([CI('_weird_type')]);
  });
});
