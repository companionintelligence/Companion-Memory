import type { GraphEntityInputDto } from '@ci/domains/graph';

import type { StagedEntity } from '../../entities/StagedEntityEntity';
import { toGraphEntity } from '../entities';
import {
  claimedCoordinates,
  legacyKeyClaims,
  legacyNaturalKeyFor,
  planLegacyKeyMoves,
  type ImportedEntityRow,
  type LegacyKeyClaim,
  type MergedAwayRow,
} from '../legacyKeys';

/**
 * The re-key plan for contacts whose key moved when shared handles stopped
 * being keys. Every case here is a decision about WHOSE history an existing
 * Person row becomes — get it wrong and one colleague inherits another's.
 * Invented data throughout (555-01XX, example.com).
 */

function staged(overrides: Partial<StagedEntity> = {}): StagedEntity {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    runId: '22222222-2222-2222-2222-222222222222',
    userId: '33333333-3333-3333-3333-333333333333',
    type: 'contact',
    name: 'Priya Natarajan',
    metadata: {},
    identityKey: 'priya@example.com',
    legacyIdentityKey: '5550100100',
    dataSource: 'vcard',
    graphDirty: false,
    pushStatus: 'pending',
    pushError: null,
    pushedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as StagedEntity;
}

/** The batch shape PushStage hands over: each input with the staged rows behind it. */
function batchOf(...rows: StagedEntity[]): Array<{ input: GraphEntityInputDto; rows: StagedEntity[] }> {
  const byKey = new Map<string, { input: GraphEntityInputDto; rows: StagedEntity[] }>();

  for (const row of rows) {
    const input = toGraphEntity(row)!;
    const entry = byKey.get(input.key);

    if (entry) {
      entry.rows.push(row);
    } else {
      byKey.set(input.key, { input, rows: [row] });
    }
  }

  return [...byKey.values()];
}

const found = (
  key: string,
  name: string | null,
  properties: Record<string, unknown> = {},
  mergedFrom: MergedAwayRow[] = [],
): ImportedEntityRow => ({
  entityType: 'Person',
  sourceSystem: 'vcard',
  key,
  entityId: `entity:${key}`,
  name,
  properties,
  mergedFrom,
});

const claim = (
  key: string,
  legacyKey: string,
  name: string | null,
  handles: string[] = [],
): LegacyKeyClaim => ({
  entityType: 'Person',
  sourceSystem: 'vcard',
  key,
  legacyKey,
  name,
  handles,
});

const merged = (
  entityId: string,
  name: string | null,
  properties: Record<string, unknown>,
): MergedAwayRow => ({
  entityId,
  name,
  properties,
});

describe('legacyNaturalKeyFor', () => {
  it('is the natural key the row was minted under before the key moved', () => {
    expect(legacyNaturalKeyFor(staged())).toBe('contact:5550100100');
  });

  it('is null when nothing moved', () => {
    expect(legacyNaturalKeyFor(staged({ legacyIdentityKey: null }))).toBeNull();
    expect(legacyNaturalKeyFor(staged({ legacyIdentityKey: 'priya@example.com' }))).toBeNull();
  });

  it('follows a contact that moved from a shared line to its name', () => {
    const row = staged({ name: 'Tom Becker', identityKey: null });

    expect(legacyNaturalKeyFor(row)).toBe('contact:5550100100');
    expect(toGraphEntity(row)?.key).toBe('contact:tom becker');
  });
});

describe('legacyKeyClaims', () => {
  it('claims the old coordinate under the new key, with the card’s own name', () => {
    expect(legacyKeyClaims(batchOf(staged()))).toEqual([
      {
        entityType: 'Person',
        sourceSystem: 'vcard',
        key: 'contact:priya@example.com',
        legacyKey: 'contact:5550100100',
        name: 'Priya Natarajan',
        handles: ['priya@example.com', '5550100100'],
      },
    ]);
  });

  it('carries every handle the card lists, normalized the way staging compares them', () => {
    const [made] = legacyKeyClaims(
      batchOf(
        staged({
          metadata: {
            Emails: ['Priya@Example.com'],
            Phones: ['(555) 010-0100', '+1 555 010 0199'],
            Faxes: '555-010-0101',
          },
        }),
      ),
    );

    expect(made.handles).toEqual(['priya@example.com', '5550100100', '5550100199', '5550100101']);
  });

  it('adds the handles of a second row making the same claim to the first', () => {
    const batch = batchOf(staged({ id: 'a' }), staged({ id: 'b', metadata: { Phones: ['(555) 010-0133'] } }));

    expect(legacyKeyClaims(batch)).toEqual([
      expect.objectContaining({ handles: ['priya@example.com', '5550100100', '5550100133'] }),
    ]);
  });

  it('does not claim an old key that is still another card’s CURRENT key', () => {
    // Somebody still keys on the line (they listed it alone): the row is theirs.
    const batch = batchOf(
      staged(),
      staged({ id: 'b', name: 'Priya N', identityKey: '5550100100', legacyIdentityKey: null }),
    );

    expect(legacyKeyClaims(batch)).toEqual([]);
  });

  it('ignores a row of another source riding on the same key', () => {
    const batch = batchOf(
      staged({ id: 'a', dataSource: 'vcard', legacyIdentityKey: null }),
      staged({ id: 'b', dataSource: 'contact_list' }),
    );

    expect(legacyKeyClaims(batch)).toEqual([]);
  });

  it('claims once for two rows making the same claim', () => {
    const batch = batchOf(staged({ id: 'a' }), staged({ id: 'b' }));

    expect(legacyKeyClaims(batch)).toHaveLength(1);
  });

  it('asks about every old key and every new one', () => {
    const coordinates = claimedCoordinates(legacyKeyClaims(batchOf(staged())));

    expect(coordinates.map((c) => c.key)).toEqual(['contact:5550100100', 'contact:priya@example.com']);
  });
});

describe('planLegacyKeyMoves', () => {
  it('moves a row onto its only claimant’s new key', () => {
    const plan = planLegacyKeyMoves(
      [claim('contact:5550100177', 'contact:5550100150', 'Omar Haddad')],
      [found('contact:5550100150', 'Omar Haddad')],
    );

    expect(plan).toEqual({
      moves: [
        {
          entityType: 'Person',
          sourceSystem: 'vcard',
          fromKey: 'contact:5550100150',
          toKey: 'contact:5550100177',
          // One person's row, claimed by that person: nothing to rebuild.
          resetProperties: false,
          dropMergedFrom: [],
        },
      ],
      kept: 0,
    });
  });

  it('does nothing where there was never a row', () => {
    expect(planLegacyKeyMoves([claim('contact:b', 'contact:a', 'Omar Haddad')], [])).toEqual({
      moves: [],
      kept: 0,
    });
  });

  it('gives a collapsed office Person to the colleague it is named after, and no one else', () => {
    // Three colleagues keyed on one switchboard were ONE row, named after the
    // card that staged first. Each claims it now.
    const plan = planLegacyKeyMoves(
      [
        claim('contact:tom@example.com', 'contact:5550100100', 'Tom Becker'),
        claim('contact:priya@example.com', 'contact:5550100100', 'Priya Natarajan'),
        claim('contact:5550100142', 'contact:5550100100', 'Lena Ortiz'),
      ],
      [found('contact:5550100100', 'Priya Natarajan')],
    );

    expect(plan.moves).toEqual([
      expect.objectContaining({
        fromKey: 'contact:5550100100',
        toKey: 'contact:priya@example.com',
        // It held three people; it is rebuilt from Priya's card alone.
        resetProperties: true,
      }),
    ]);
  });

  it('rebuilds a row whose stored Names list several people, even when only one of them claims it', () => {
    // Only Priya's card is in this export, but the row still carries the
    // others — a union of the lists on ingest would keep them there.
    const plan = planLegacyKeyMoves(
      [claim('contact:priya@example.com', 'contact:5550100100', 'Priya Natarajan')],
      [found('contact:5550100100', 'Priya Natarajan', { Names: ['Priya Natarajan', 'Tom Becker'] })],
    );

    expect(plan.moves).toEqual([expect.objectContaining({ resetProperties: true })]);
  });

  it('does not rebuild a row claimed only by one person\u2019s own copies', () => {
    const plan = planLegacyKeyMoves(
      [
        claim('contact:matt@example.com', 'contact:5550100160', 'Matt Okafor'),
        claim('contact:5550100161', 'contact:5550100160', 'Matthew Okafor'),
      ],
      [found('contact:5550100160', 'Matthew Okafor', { Names: ['Matthew Okafor', 'Matt Okafor'] })],
    );

    expect(plan.moves).toEqual([expect.objectContaining({ resetProperties: false })]);
  });

  it('keeps a row every claimant is somebody else than', () => {
    // A card that merely USED to share a line with the row's person must not
    // inherit that person's history.
    const plan = planLegacyKeyMoves(
      [claim('contact:tom@example.com', 'contact:5550100100', 'Tom Becker')],
      [found('contact:5550100100', 'Priya Natarajan')],
    );

    expect(plan).toEqual({ moves: [], kept: 1 });
  });

  it('lets a row go to a nickname of its own name', () => {
    const plan = planLegacyKeyMoves(
      [claim('contact:matt@example.com', 'contact:5550100160', 'Matt Okafor')],
      [found('contact:5550100160', 'Matthew Okafor')],
    );

    expect(plan.moves).toHaveLength(1);
  });

  it('never moves onto a key that already has a row', () => {
    const plan = planLegacyKeyMoves(
      [claim('contact:priya@example.com', 'contact:5550100100', 'Priya Natarajan')],
      [found('contact:5550100100', 'Priya Natarajan'), found('contact:priya@example.com', 'Priya Natarajan')],
    );

    expect(plan).toEqual({ moves: [], kept: 1 });
  });

  it('moves at most one row onto any new key', () => {
    // One person's two old rows (a fragment each) both claimed by the key their
    // cards now share: one of them moves, the other stays a fragment as before.
    const plan = planLegacyKeyMoves(
      [
        claim('contact:grace@example.com', 'contact:5550100170', 'Grace Whitaker'),
        claim('contact:grace@example.com', 'contact:5550100171', 'Grace Whitaker'),
      ],
      [found('contact:5550100170', 'Grace Whitaker'), found('contact:5550100171', 'Grace Whitaker')],
    );

    expect(plan.moves).toEqual([expect.objectContaining({ fromKey: 'contact:5550100170' })]);
    expect(plan.kept).toBe(1);
  });

  it('gives a nameless row to the first claimant in staging order', () => {
    const plan = planLegacyKeyMoves(
      [
        claim('contact:first@example.com', 'contact:5550100199', 'Ines de Souza'),
        claim('contact:second@example.com', 'contact:5550100199', 'Paul de Groot'),
      ],
      [found('contact:5550100199', null)],
    );

    expect(plan.moves).toEqual([expect.objectContaining({ toKey: 'contact:first@example.com' })]);
  });
});

describe('planLegacyKeyMoves, for a collapsed row that others were merged into', () => {
  // The office again, with each card's handles as staging read them.
  const office = [
    claim('contact:tom@example.com', 'contact:5550100100', 'Tom Becker', [
      'tom@example.com',
      '5550100100',
      '5550100188',
    ]),
    claim('contact:priya@example.com', 'contact:5550100100', 'Priya Natarajan', [
      'priya@example.com',
      '5550100100',
    ]),
    claim('contact:5550100142', 'contact:5550100100', 'Lena Ortiz', ['5550100142', '5550100100']),
  ];

  it('keeps the merges that are the heir’s and names the ones that are a colleague’s', () => {
    const plan = planLegacyKeyMoves(office, [
      found('contact:5550100100', 'Priya Natarajan', {}, [
        // Her own mail and chat stubs, merged into what showed as her card.
        merged('priya-mail', 'Priya Natarajan', { emails: ['priya.n@mail.example'] }),
        merged('priya-chat', 'Priya', { names: ['Priya'] }),
        // The switchboard is on her card as well as her colleagues'.
        merged('switchboard', '+1 555-010-0100', { phones: ['5550100100'] }),
        // Nothing says whose this is, so the merge keeps what it brought.
        merged('unknown', null, { phones: ['5550100177'] }),
        // Named after a colleague.
        merged('tom-mail', 'Tom Becker', { emails: ['tom.b@mail.example'] }),
        // Named after nothing, but holding what only a colleague's card lists:
        // the stub a shared-email auto-merge folds in.
        merged('tom-bare', 'tom@example.com', { emails: ['tom@example.com'] }),
        merged('tom-cell', '(555) 010-0188', { Phones: ['+1 (555) 010-0188'] }),
        merged('lena-voice', '+1 555-010-0142', { phone: '5550100142', phones: ['5550100142'] }),
      ]),
    ]);

    expect(plan.moves).toEqual([
      expect.objectContaining({
        toKey: 'contact:priya@example.com',
        resetProperties: true,
        dropMergedFrom: ['tom-mail', 'tom-bare', 'tom-cell', 'lena-voice'],
      }),
    ]);
  });

  it('names none for a move that is not reset', () => {
    const plan = planLegacyKeyMoves(
      [claim('contact:5550100177', 'contact:5550100150', 'Omar Haddad', ['5550100177', '5550100150'])],
      [
        found('contact:5550100150', 'Omar Haddad', {}, [
          merged('other', 'Grace Whitaker', { names: ['Grace'] }),
        ]),
      ],
    );

    expect(plan.moves).toEqual([expect.objectContaining({ resetProperties: false, dropMergedFrom: [] })]);
  });

  it('does not count the heir’s other copies of the card as colleagues', () => {
    const plan = planLegacyKeyMoves(
      [
        claim('contact:matt@example.com', 'contact:5550100160', 'Matt Okafor', [
          'matt@example.com',
          '5550100160',
        ]),
        claim('contact:5550100161', 'contact:5550100160', 'Matthew Okafor', ['5550100161', '5550100160']),
        claim('contact:tom@example.com', 'contact:5550100160', 'Tom Becker', [
          'tom@example.com',
          '5550100160',
        ]),
      ],
      [
        found('contact:5550100160', 'Matt Okafor', {}, [
          merged('matthew-voice', '+1 555-010-0161', { phones: ['5550100161'] }),
          merged('tom-bare', 'tom@example.com', { emails: ['tom@example.com'] }),
        ]),
      ],
    );

    expect(plan.moves).toEqual([
      expect.objectContaining({ resetProperties: true, dropMergedFrom: ['tom-bare'] }),
    ]);
  });

  it('judges by the row’s own name when the heir’s card has none', () => {
    const plan = planLegacyKeyMoves(
      [
        claim('contact:priya@example.com', 'contact:5550100100', null, ['priya@example.com', '5550100100']),
        claim('contact:tom@example.com', 'contact:5550100100', 'Tom Becker', [
          'tom@example.com',
          '5550100100',
        ]),
      ],
      [
        found('contact:5550100100', 'Priya Natarajan', {}, [
          merged('priya-mail', 'Priya Natarajan', { emails: ['priya.n@mail.example'] }),
          merged('tom-bare', 'tom@example.com', { emails: ['tom@example.com'] }),
        ]),
      ],
    );

    expect(plan.moves).toEqual([
      expect.objectContaining({ toKey: 'contact:priya@example.com', dropMergedFrom: ['tom-bare'] }),
    ]);
  });

  it('can go by names alone when no colleague’s card is in the export', () => {
    // Reset for the Names the row accumulated; with no card of Tom's to
    // compare against, a stub named by its address says nothing either way.
    const plan = planLegacyKeyMoves(
      [claim('contact:priya@example.com', 'contact:5550100100', 'Priya Natarajan', ['priya@example.com'])],
      [
        found('contact:5550100100', 'Priya Natarajan', { Names: ['Priya Natarajan', 'Tom Becker'] }, [
          merged('tom-mail', 'Tom Becker', { emails: ['tom.b@mail.example'] }),
          merged('tom-bare', 'tom@example.com', { emails: ['tom@example.com'] }),
        ]),
      ],
    );

    expect(plan.moves).toEqual([
      expect.objectContaining({ resetProperties: true, dropMergedFrom: ['tom-mail'] }),
    ]);
  });
});
