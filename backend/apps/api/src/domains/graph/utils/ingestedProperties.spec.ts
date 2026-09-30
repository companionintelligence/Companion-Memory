import {
  IDENTITY_LIST_KEYS,
  mergedPropertiesSql,
  mergeIngestedProperties,
  unionKeysFor,
} from './ingestedProperties';

/**
 * The TS definition of a re-ingest's property merge. Its SQL twin runs the same
 * cases against real Postgres in
 * `services/GraphIngestService.propertyMerge.integration.spec.ts`.
 *
 * Every person, number and address here is invented: 555-01XX under real area
 * codes, `.example` mail domains.
 */

const IDENTITY = unionKeysFor();

describe('unionKeysFor', () => {
  it('always unions the plural identity keys a person merge folds', () => {
    expect(unionKeysFor()).toEqual(['emails', 'phones', 'names', 'Phones', 'Faxes']);
    expect(unionKeysFor(null)).toEqual([...IDENTITY_LIST_KEYS]);
  });

  it('adds the keys the parser declared, cleaned and without repeating an identity key', () => {
    expect(unionKeysFor([' URLs', 'Phones', '', 'Orders', 'URLs'])).toEqual([
      ...IDENTITY_LIST_KEYS,
      'URLs',
      'Orders',
    ]);
  });
});

describe('mergeIngestedProperties', () => {
  describe('what the source does not send is not its to erase', () => {
    it('keeps everything a person merge folded into its own card', () => {
      // Ada's card, after Bo's chat stub was merged into her: Bo's number and
      // name sit in the identity lists, and Bo's `Organization` filled a gap.
      const merged = {
        Names: ['Ada Quill'],
        Phones: ['(212) 555-0118', '+1 212-555-0144'],
        phones: ['2125550118', '2125550144'],
        names: ['Ada Quill', 'Ada Q'],
        Organization: 'Quill Legal',
      };
      const card = {
        Names: ['Ada Quill'],
        Phones: ['(212) 555-0118'],
        phones: ['2125550118'],
        names: ['Ada Quill'],
      };

      expect(mergeIngestedProperties(merged, card, unionKeysFor(['Names', 'Phones']))).toEqual(merged);
    });

    it('keeps the self flag, structured names and enrichment keys another writer added', () => {
      const stored = {
        phones: ['2025550142'],
        is_self: true,
        first_name: 'Dana',
        last_name: 'Marsh',
        planner: { trust_mode: 'ask' },
      };

      expect(mergeIngestedProperties(stored, { phones: ['2025550142'], Source: 'vCard' }, IDENTITY)).toEqual({
        ...stored,
        Source: 'vCard',
      });
    });

    it('does not modify the stored bag it was given', () => {
      const stored = { phones: ['2025550142'] };

      mergeIngestedProperties(stored, { phones: ['2025550131'] }, IDENTITY);

      expect(stored).toEqual({ phones: ['2025550142'] });
    });
  });

  describe('what the source does send', () => {
    it('takes its latest word on a scalar it owns', () => {
      expect(
        mergeIngestedProperties({ Source: 'vCard', avatar_url: 'a' }, { Source: 'vCard 4' }, IDENTITY),
      ).toEqual({
        Source: 'vCard 4',
        avatar_url: 'a',
      });
    });

    it('reads JSON null as saying nothing, not as a deletion', () => {
      expect(
        mergeIngestedProperties(
          { avatar_url: 'a', phones: ['1'] },
          { avatar_url: null, phones: null },
          IDENTITY,
        ),
      ).toEqual({
        avatar_url: 'a',
        phones: ['1'],
      });
    });

    it('adds a new member to an identity list after the ones already held', () => {
      expect(
        mergeIngestedProperties(
          { phones: ['2125550118', '2125550144'] },
          { phones: ['2125550199', '2125550118'] },
          IDENTITY,
        ),
      ).toEqual({ phones: ['2125550118', '2125550144', '2125550199'] });
    });

    it('cannot remove a set member: a number dropped from a card stays on the person', () => {
      // The deliberate cost of merging — see the module header.
      expect(
        mergeIngestedProperties(
          { phones: ['2025550142', '2025550131'] },
          { phones: ['2025550131'] },
          IDENTITY,
        ),
      ).toEqual({
        phones: ['2025550142', '2025550131'],
      });
    });

    it('unions the keys the parser declared, and replaces an array it did not', () => {
      // `URLs` is a vCard accumulate key; `coords` is a pair, not a set, and
      // unioning [lat, lng] with a new [lat, lng] would be nonsense.
      const keys = unionKeysFor(['URLs']);

      expect(
        mergeIngestedProperties(
          { URLs: ['https://a.example'], coords: [1, 2] },
          { URLs: ['https://b.example'], coords: [3, 4] },
          keys,
        ),
      ).toEqual({
        URLs: ['https://a.example', 'https://b.example'],
        coords: [3, 4],
      });
    });

    it('treats a lone stored value as a list of one', () => {
      // An older contact import stored `Phones` as a bare string.
      expect(
        mergeIngestedProperties(
          { Phones: '(212) 555-0110' },
          { Phones: ['(212) 555-0110', '(212) 555-0199'] },
          IDENTITY,
        ),
      ).toEqual({
        Phones: ['(212) 555-0110', '(212) 555-0199'],
      });
    });

    it('drops nulls and empty strings from a set, as the staging layer does', () => {
      expect(mergeIngestedProperties({ phones: ['1', ''] }, { phones: [null, '', '2'] }, IDENTITY)).toEqual({
        phones: ['1', '2'],
      });
    });

    it('compares set members as jsonb does: objects by content, strings apart from numbers', () => {
      const keys = unionKeysFor(['Orders', 'prices']);

      expect(
        mergeIngestedProperties(
          { Orders: [{ price: 4.5, date: '2022-12-16' }], prices: ['10.19'] },
          { Orders: [{ date: '2022-12-16', price: 4.5 }], prices: [10.19] },
          keys,
        ),
      ).toEqual({ Orders: [{ price: 4.5, date: '2022-12-16' }], prices: ['10.19', 10.19] });
    });
  });

  it('reads a non-object on either side as an empty bag', () => {
    expect(mergeIngestedProperties(null, { a: 1 }, IDENTITY)).toEqual({ a: 1 });
    expect(mergeIngestedProperties({ a: 1 }, undefined, IDENTITY)).toEqual({ a: 1 });
    expect(mergeIngestedProperties(['x'] as never, ['y'] as never, IDENTITY)).toEqual({});
  });
});

describe('mergedPropertiesSql', () => {
  const sql = mergedPropertiesSql('"entities"."properties"', 'EXCLUDED."properties"', ':unionKeys::text[]');

  it('merges into the existing bag rather than replacing it', () => {
    expect(sql.startsWith(`(CASE WHEN jsonb_typeof("entities"."properties") = 'object'`)).toBe(true);
    expect(sql).toContain(` || COALESCE((SELECT jsonb_object_agg(said.key, `);
  });

  it('takes the set keys as a bound array, never spliced into the statement', () => {
    expect(sql).toContain('said.key = ANY(:unionKeys::text[])');
    expect(sql).not.toMatch(/'phones'|'Phones'/);
  });

  it('skips JSON null values and blank set members, as the TS merge does', () => {
    expect(sql).toContain(`WHERE jsonb_typeof(said.value) <> 'null'`);
    expect(sql).toContain(`member.value NOT IN ('null'::jsonb, '""'::jsonb)`);
  });
});
