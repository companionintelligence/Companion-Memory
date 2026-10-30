import { EntityResolutionService } from './EntityResolutionService';

const ctx = { userId: 'user-1' } as never;

type Rows = Array<Record<string, unknown> | null>;

function makeService({
  people = [],
  places = [],
  concepts = [],
}: {
  people?: Rows;
  places?: Rows;
  concepts?: Rows;
}) {
  const empty = () => ({ findByIds: jest.fn().mockResolvedValue([]) });
  const personService = { findByIds: jest.fn().mockResolvedValue(people) };
  const placeService = { findByIds: jest.fn().mockResolvedValue(places) };
  const conceptService = { findByIds: jest.fn().mockResolvedValue(concepts) };

  const service = new EntityResolutionService(
    empty() as never, // action
    empty() as never, // answer
    empty() as never, // browser activity
    empty() as never, // communication
    conceptService as never,
    empty() as never, // content
    empty() as never, // event
    empty() as never, // file
    empty() as never, // file chunk
    empty() as never, // item
    empty() as never, // note
    personService as never,
    placeService as never,
    empty() as never, // product
    { find: jest.fn().mockResolvedValue([]) } as never, // receipt repository
    empty() as never, // task
    empty() as never, // thread
  );

  return { service };
}

describe('EntityResolutionService forgotten entities', () => {
  it('leaves out a person the user asked Memory to forget, even while an index row still finds them', async () => {
    const { service } = makeService({
      people: [
        { id: 'forgotten', name: 'Jane Smith', isActive: false },
        { id: 'kept', name: 'Jane Doe', isActive: true },
      ],
    });

    const resolved = await service.resolve(ctx, [
      { type: 'person', id: 'forgotten' },
      { type: 'person', id: 'kept' },
    ]);

    expect(resolved.has('person:forgotten')).toBe(false);
    expect(resolved.get('person:kept')?.entity).toEqual(expect.objectContaining({ name: 'Jane Doe' }));
  });

  it('leaves out forgotten places and concepts the same way, and keeps a row whose flag was never set', async () => {
    const { service } = makeService({
      places: [
        { id: 'cabin', name: 'Ravenwood Cottage', isActive: false },
        { id: 'cafe', name: 'Blue Bottle', isActive: true },
      ],
      concepts: [
        { id: 'quill', name: 'Quillfeather Project', isActive: false },
        { id: 'photo', name: 'Photography' },
      ],
    });

    const resolved = await service.resolve(ctx, [
      { type: 'place', id: 'cabin' },
      { type: 'place', id: 'cafe' },
      { type: 'concept', id: 'quill' },
      { type: 'concept', id: 'photo' },
    ]);

    expect([...resolved.keys()].sort()).toEqual(['concept:photo', 'place:cafe']);
  });
});
