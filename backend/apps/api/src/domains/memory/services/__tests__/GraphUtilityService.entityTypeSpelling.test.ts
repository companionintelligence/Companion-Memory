import { InMemoryRepository } from '../../../__tests__/support/inMemoryRepository';
import { GraphNodeEntity } from '../../entities/GraphNodeEntity';
import type { RelationshipEntity } from '../../entities/RelationshipEntity';
import { GraphUtilityService } from '../GraphUtilityService';

/**
 * The `entity_type` a node write leaves on a row, whatever spelling the payload
 * carries.
 *
 * `memory.remember` now sends a canonical type (WriteKnowledgeTool
 * .entityTypeSpelling.test.ts). The payloads below are the ones it queued
 * before that: `person` failed `valid_entity_type` and dead-lettered, and the
 * jobs page replays a dead letter verbatim, so the write itself has to read the
 * old spelling the way the tool now does. Postgres, and the CHECK, are in
 * WriteKnowledgeTool.entityTypeSpelling.integration.test.ts.
 */

const OWNER = 'owner-1';
const NODE = 'node-1';
const LINKED_ID = '6c1f7a52-9d1e-5b0a-8f3e-2a4b6c8d0e1f';

function storedNode(overrides: Partial<GraphNodeEntity> = {}): GraphNodeEntity {
  return Object.assign(new GraphNodeEntity(), {
    entity_id: NODE,
    owner_user_id: OWNER,
    entity_type: 'Person',
    outgoing_relationships: [],
    name: 'Alex Rivera',
    description: null,
    properties: { emails: ['alex@example.com'] },
    dossier: null,
    search_content: null,
    linked_table: 'import:google-contacts',
    linked_id: LINKED_ID,
    is_active: true,
    is_archived: false,
    ...overrides,
  });
}

function setup(...nodes: GraphNodeEntity[]) {
  const repo = new InMemoryRepository<GraphNodeEntity>('entity_id');
  repo.seed(...nodes);
  const edges = new InMemoryRepository<RelationshipEntity>('relationship_id');
  const service = new GraphUtilityService(repo as never, edges as never, { setContext: jest.fn() } as never);

  return { service, nodes: repo };
}

describe('GraphUtilityService.createOrUpdateNode — the entity_type it writes', () => {
  it('inserts a known type in its canonical spelling', async () => {
    const { service, nodes } = setup();

    for (const [entityId, entityType, stored] of [
      ['new-1', 'person', 'Person'],
      ['new-2', ' PLACE ', 'Place'],
      ['new-3', 'organization', 'Organization'],
    ]) {
      const { node, created } = await service.createOrUpdateNode(OWNER, { entityId, entityType, name: 'x' });

      expect(created).toBe(true);
      expect(node.entity_type).toBe(stored);
      expect(nodes.get(entityId)?.entity_type).toBe(stored);
    }
  });

  it('inserts a type it does not know exactly as given', async () => {
    const { service, nodes } = setup();

    await service.createOrUpdateNode(OWNER, { entityId: 'new-1', entityType: 'Restaurant', name: 'Nopa' });

    expect(nodes.get('new-1')?.entity_type).toBe('Restaurant');
  });

  it('keeps the stored type when the payload names it in another case, and still applies the rest', async () => {
    const { service, nodes } = setup(storedNode());

    await service.createOrUpdateNode(OWNER, {
      entityId: NODE,
      entityType: 'person',
      properties: { occupation: 'dentist' },
      mergeProperties: true,
    });

    expect(nodes.get(NODE)).toMatchObject({
      entity_type: 'Person',
      linked_id: LINKED_ID,
      properties: { emails: ['alex@example.com'], occupation: 'dentist' },
    });
  });

  it('keeps the stored type when the payload uses another name for it, so the row stays on its import key', async () => {
    const person = setup(storedNode());
    await person.service.createOrUpdateNode(OWNER, { entityId: NODE, entityType: 'contact' });
    expect(person.nodes.get(NODE)?.entity_type).toBe('Person');

    const location = setup(storedNode({ entity_type: 'Location', name: 'Home' }));
    await location.service.createOrUpdateNode(OWNER, { entityId: NODE, entityType: 'place' });
    expect(location.nodes.get(NODE)?.entity_type).toBe('Location');
  });

  it('retypes to the canonical spelling when the payload names another type', async () => {
    const { service, nodes } = setup(storedNode({ entity_type: 'Concept' }));

    await service.createOrUpdateNode(OWNER, { entityId: NODE, entityType: 'person' });

    expect(nodes.get(NODE)).toMatchObject({ entity_type: 'Person', linked_id: LINKED_ID });
  });

  it("refuses a retype in any spelling onto a key the canonical type's twin holds", async () => {
    // With the payload's own spelling the twin was on another key as far as the
    // check (and entities_linked_uniq) could tell, so `PERSON` slipped past it.
    const twin = storedNode({ entity_id: 'person-twin' });

    for (const entityType of ['person', 'PERSON', 'Person']) {
      const { service, nodes } = setup(storedNode({ entity_type: 'Concept' }), twin);

      await expect(service.createOrUpdateNode(OWNER, { entityId: NODE, entityType })).rejects.toThrow(
        `Entity ${NODE} cannot become the Person linked to import:google-contacts record ${LINKED_ID}: ` +
          'entity person-twin already is',
      );
      expect(nodes.get(NODE)?.entity_type).toBe('Concept');
    }
  });
});
