import type { StagedEntity } from '../../entities/StagedEntityEntity';
import { entityTypeFor, isGraphExcluded, naturalKeyFor, toGraphEntity } from '../entities';

/**
 * The entity lane, tested at the mapper.
 *
 * The bug this replaces was not subtle — the normalized handle was passed as
 * `linkedId`, which is a `uuid` column, so every entity carrying a handle died
 * on "invalid input syntax for type uuid" and every entity without one was
 * skipped for want of a key. Nothing resolved, `entity_mappings` stayed empty,
 * and a real Amazon import dropped all 613 of its item→entity edges.
 *
 * It survived review because the only test was a unit test whose mocked
 * `PersonService` accepted whatever the mapper produced. So these assertions are
 * about the SHAPE handed to the server, and the integration spec alongside them
 * is about what a real database does with it.
 */
function staged(overrides: Partial<StagedEntity> = {}): StagedEntity {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    runId: '22222222-2222-2222-2222-222222222222',
    userId: '33333333-3333-3333-3333-333333333333',
    type: 'contact',
    name: 'Alice Smith',
    metadata: {},
    identityKey: 'alice@example.com',
    dataSource: 'gmail',
    graphDirty: false,
    pushStatus: 'pending',
    pushError: null,
    pushedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as StagedEntity;
}

describe('naturalKeyFor', () => {
  it('prefers the handle, because display names drift between sources', () => {
    const key = naturalKeyFor(staged({ name: 'Alice' }));

    expect(key).toBe(naturalKeyFor(staged({ name: 'Alice Smith' })));
    expect(key).toContain('alice@example.com');
  });

  it('falls back to the name for the things that have no handle by nature', () => {
    // Artists, genres and dishes are most of what a media archive stages. The
    // old lane skipped every one of them.
    expect(naturalKeyFor(staged({ type: 'person', name: 'Foghat', identityKey: null }))).toBe(
      'person:foghat',
    );
  });

  it('is case-insensitive on the name, so one artist is not two', () => {
    expect(naturalKeyFor(staged({ name: 'FOGHAT', identityKey: null }))).toBe(
      naturalKeyFor(staged({ name: 'foghat', identityKey: null })),
    );
  });

  it('keeps types apart, so a restaurant and its dish cannot collide on a name', () => {
    expect(naturalKeyFor(staged({ type: 'food', name: 'Napoli', identityKey: null }))).not.toBe(
      naturalKeyFor(staged({ type: 'place', name: 'Napoli', identityKey: null })),
    );
  });

  it('gives up only when there is neither handle nor name', () => {
    expect(naturalKeyFor(staged({ name: null, identityKey: null }))).toBeNull();
    expect(naturalKeyFor(staged({ name: '   ', identityKey: null }))).toBeNull();
  });
});

describe('isGraphExcluded', () => {
  it('keeps email_thread out of the graph', () => {
    // gmail.ts emits one per message carrying the raw Message-ID as its name.
    // Without this gate they fall through to Concept, and because the explorer
    // never type-filters connective types away and orders newest-first, the
    // Concept slice of the canvas becomes Message-ID strings with degree 0 —
    // one per email imported. Upstream measured ≈148k of them.
    expect(isGraphExcluded(staged({ type: 'email_thread' }))).toBe(true);
    expect(isGraphExcluded(staged({ type: 'EMAIL_THREAD' }))).toBe(true);
  });

  it('lets everything else through', () => {
    for (const type of ['contact', 'person', 'place', 'music_genre', 'whatever-a-csv-said']) {
      expect(isGraphExcluded(staged({ type }))).toBe(false);
    }
  });
});

describe('entityTypeFor', () => {
  it.each([
    ['contact', 'Person'],
    ['person', 'Person'],
    ['place', 'Location'],
    ['music_genre', 'Concept'],
  ])('files a %s as a %s', (type, expected) => {
    expect(entityTypeFor(staged({ type }))).toBe(expected);
  });

  it('files an unknown parser type as a Concept rather than refusing it', () => {
    // One parser reads its type straight out of a CSV column, so the set is not
    // closed and an unrecognised value must not cost the entity its row.
    expect(entityTypeFor(staged({ type: 'something_a_csv_said' }))).toBe('Concept');
  });
});

describe('toGraphEntity', () => {
  it('never puts a handle where a uuid belongs', () => {
    // The whole bug in one assertion: the identity travels as a natural KEY,
    // which GraphIngestService hashes into linked_id itself.
    const input = toGraphEntity(staged());

    expect(input).not.toBeNull();
    expect(input).not.toHaveProperty('linkedId');
    expect(input?.key).toContain('alice@example.com');
  });

  it('carries the email where GraphIngestService looks for identifiers', () => {
    // `emails`/`phones` are what populate ci.entity_identifiers — the index that
    // later matches this person to the same person in another export.
    const input = toGraphEntity(staged());

    expect(input?.properties).toMatchObject({
      email: 'alice@example.com',
      emails: ['alice@example.com'],
      names: ['Alice Smith'],
    });
  });

  it('routes a phone handle to phones, not emails', () => {
    const input = toGraphEntity(staged({ identityKey: '9145820196' }));

    expect(input?.properties).toMatchObject({ phone: '9145820196', phones: ['9145820196'] });
    expect(input?.properties).not.toHaveProperty('emails');
  });

  it('attributes the entity to the parser that produced it', () => {
    // sourceSystem is part of the server-side identity, so a missing one must be
    // a stable string rather than undefined.
    expect(toGraphEntity(staged({ dataSource: 'amazon_music' }))?.sourceSystem).toBe('amazon_music');
    expect(toGraphEntity(staged({ dataSource: null }))?.sourceSystem).toBe('unknown');
  });

  it('preserves the parser metadata it was staged with', () => {
    const input = toGraphEntity(staged({ metadata: { ASIN: 'B000QJJSW6', Source: 'Amazon Music' } }));

    expect(input?.properties).toMatchObject({ ASIN: 'B000QJJSW6', Source: 'Amazon Music' });
  });

  it('resolves a handle-less artist instead of dropping it', () => {
    const input = toGraphEntity(staged({ type: 'person', name: 'Foghat', identityKey: null }));

    expect(input).toMatchObject({ key: 'person:foghat', entityType: 'Person', name: 'Foghat' });
  });

  it('returns null only for an entity with nothing to key on', () => {
    expect(toGraphEntity(staged({ name: null, identityKey: null }))).toBeNull();
  });
});
