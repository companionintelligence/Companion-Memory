import type { GraphNodeEntity } from '@ci/domains/memory';

import { CI, DCTERMS, LDP, RDFS, RDF_TYPE, XSD, isNamedNode, type Quad } from '../../rdf';
import { ContainerService } from '../ContainerService';
import { WebIdService } from '../WebIdService';

/**
 * The container is what lets a Solid client browse the pod. These tests pin its
 * LDP typing, the `ldp:contains` membership + inline member metadata, and the
 * honest `ci:truncated` flag when the listing is capped.
 */
const ORIGIN = 'https://ci.example';
const USER = 'user-1';
const CONTAINER = `https://ci.example/solid/storage/${USER}/entity/`;
const service = new ContainerService(new WebIdService());

const member = (id: string, overrides: Partial<GraphNodeEntity> = {}): GraphNodeEntity =>
  ({
    entity_id: id,
    entity_type: 'Person',
    name: `Person ${id}`,
    description: null,
    properties: {},
    created_at: new Date('2020-01-01T00:00:00.000Z'),
    updated_at: new Date('2020-01-01T00:00:00.000Z'),
    owner_user_id: USER,
    ...overrides,
  }) as GraphNodeEntity;

const objectsOf = (quads: Quad[], subject: string, predicate: string): string[] =>
  quads
    .filter((q) => q.subject.value === subject && q.predicate.value === predicate)
    .map((q) => q.object.value);

describe('ContainerService.build', () => {
  it('types the container as an LDP BasicContainer and Container', () => {
    const quads = service.build([], ORIGIN, USER, { truncated: false });
    expect(objectsOf(quads, CONTAINER, RDF_TYPE)).toEqual([LDP('BasicContainer'), LDP('Container')]);
    expect(objectsOf(quads, CONTAINER, DCTERMS('title'))).toEqual(['Entities']);
  });

  it('lists each member via ldp:contains with the member pod IRI', () => {
    const quads = service.build([member('a'), member('b')], ORIGIN, USER, { truncated: false });
    const contained = objectsOf(quads, CONTAINER, LDP('contains'));
    expect(contained).toEqual([`${CONTAINER}a`, `${CONTAINER}b`]);
    const contains = quads.find((q) => q.predicate.value === LDP('contains'))!;
    expect(isNamedNode(contains.object)).toBe(true);
  });

  it('emits inline type + label for each member so a listing renders without extra fetches', () => {
    const quads = service.build([member('a', { name: 'Ada' })], ORIGIN, USER, { truncated: false });
    const memberIri = `${CONTAINER}a`;
    expect(objectsOf(quads, memberIri, RDF_TYPE)).toEqual([CI('Person')]);
    expect(objectsOf(quads, memberIri, RDFS('label'))).toEqual(['Ada']);
  });

  it('omits the member label when the entity has no name', () => {
    const quads = service.build([member('a', { name: null })], ORIGIN, USER, { truncated: false });
    expect(objectsOf(quads, `${CONTAINER}a`, RDFS('label'))).toEqual([]);
  });

  it('flags truncation with a typed boolean only when capped', () => {
    const complete = service.build([member('a')], ORIGIN, USER, { truncated: false });
    expect(complete.some((q) => q.predicate.value === CI('truncated'))).toBe(false);

    const capped = service.build([member('a')], ORIGIN, USER, { truncated: true });
    const flag = capped.find((q) => q.predicate.value === CI('truncated'))!;
    expect(flag.object).toMatchObject({ value: 'true', datatype: XSD('boolean') });
  });
});
