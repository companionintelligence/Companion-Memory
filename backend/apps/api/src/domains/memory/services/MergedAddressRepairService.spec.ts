import { readPersonAddresses } from '../types';

import {
  type AddressEdit,
  editsSinceMerge,
  foldOrder,
  offeredAddresses,
  removedByHand,
  shownByMerge,
} from './MergedAddressRepairService';

const KEPT = '00000000-0000-0000-0000-0000000000c1';
const HOP = '00000000-0000-0000-0000-0000000000c2';
const OTHER_HOP = '00000000-0000-0000-0000-0000000000c3';

const WORK = {
  label: 'work',
  street_address: '9 Elm St',
  street_address_2: null,
  city: 'Portland',
  region: null,
  postal_code: null,
  country: null,
  is_primary: true,
};
const HOME = { ...WORK, label: 'home', street_address: null, city: 'Bend', is_primary: false };

const [work, home] = readPersonAddresses({ addresses: [WORK, HOME] });

const edit = (
  changedFields: Record<string, { old?: unknown; new?: unknown }>,
  on = KEPT,
  at = '2026-11-16T12:00:00Z',
): AddressEdit => ({
  entity_id: on,
  changed_at: new Date(at),
  changed_fields: changedFields,
});

describe('removedByHand', () => {
  it('finds an address an edit took off the list', () => {
    const removed = removedByHand([edit({ addresses: { old: [WORK, HOME], new: [WORK] } })]);

    expect(removed(home)).toBe(true);
    expect(removed(work)).toBe(false);
  });

  it('finds the address a merge put in the flat fields when an edit there cleared or changed it', () => {
    // What the edit dialog saved after "Remove address" on a person whose only
    // address was the flat one a merge had copied in.
    const removed = removedByHand(
      [
        edit({
          city: { old: 'Portland', new: null },
          address: { old: '9 Elm St, Portland', new: null },
          street_address: { old: '9 Elm St', new: null },
        }),
      ],
      work,
    );

    expect(removed(work)).toBe(true);
    expect(removed(home)).toBe(false);
  });

  it('reads a flat-field edit only against the address the merge put there', () => {
    // Only the city changed. Another address in that city was never in the flat
    // fields, so the person cannot have removed it there.
    const [elsewhere] = readPersonAddresses({ addresses: [{ ...WORK, street_address: '5 Oak Ave' }] });
    const removed = removedByHand([edit({ city: { old: 'Portland', new: 'Salem' } })], work);

    expect(removed(work)).toBe(true);
    expect(removed(elsewhere)).toBe(false);
    expect(removedByHand([edit({ city: { old: 'Portland', new: 'Salem' } })])(work)).toBe(false);
  });

  it('finds nothing in an edit that only added', () => {
    const removed = removedByHand([
      edit({ addresses: { old: null, new: [WORK] }, city: { old: null, new: 'Portland' } }),
    ]);

    expect(removed(work)).toBe(false);
    expect(removed(home)).toBe(false);
  });

  it('matches a flat part whatever its case or spacing, as addressKey does', () => {
    const removed = removedByHand([edit({ street_address: { old: '9  ELM st ', new: null } })], work);

    expect(removed(work)).toBe(true);
  });
});

describe('editsSinceMerge', () => {
  const merged = new Date('2026-11-10T12:00:00Z');

  it('reads only the edits on the person the merge went into, after it', () => {
    const before = edit({ city: { old: 'Portland', new: null } }, KEPT, '2026-11-09T12:00:00Z');
    const after = edit({ city: { old: 'Portland', new: null } }, KEPT, '2026-11-11T12:00:00Z');
    const onAnotherRow = edit({ city: { old: 'Portland', new: null } }, OTHER_HOP, '2026-11-11T12:00:00Z');

    expect(
      editsSinceMerge(
        [before, after, onAnotherRow],
        { target_id: KEPT, created_at: merged },
        KEPT,
        new Map(),
      ),
    ).toEqual([after]);
  });

  it('reads the hop row from the merge on, and the kept person only once the hop row joined it', () => {
    const onHop = edit({ city: { old: 'Portland', new: null } }, HOP, '2026-11-11T12:00:00Z');
    const onKeptBeforeHop = edit({ city: { old: 'Portland', new: null } }, KEPT, '2026-11-12T12:00:00Z');
    const onKeptAfterHop = edit({ city: { old: 'Portland', new: null } }, KEPT, '2026-11-14T12:00:00Z');
    const edits = [onHop, onKeptBeforeHop, onKeptAfterHop];
    const merge = { target_id: HOP, created_at: merged };

    const hops = new Map([[HOP, { target_id: KEPT, merged_at: new Date('2026-11-13T12:00:00Z') }]]);

    expect(editsSinceMerge(edits, merge, KEPT, hops)).toEqual([onHop, onKeptAfterHop]);
    // With no record of when the hop row was merged in, every edit since the merge counts.
    expect(editsSinceMerge(edits, merge, KEPT, new Map())).toEqual(edits);
  });

  it('reads each row of a longer chain from when it took the addresses on', () => {
    // The merge went into HOP, HOP into OTHER_HOP on the 12th, OTHER_HOP into the kept person on the 14th.
    const hops = new Map([
      [HOP, { target_id: OTHER_HOP, merged_at: new Date('2026-11-12T12:00:00Z') }],
      [OTHER_HOP, { target_id: KEPT, merged_at: new Date('2026-11-14T12:00:00Z') }],
    ]);
    const onMiddleBefore = edit({ city: { old: 'Portland', new: null } }, OTHER_HOP, '2026-11-11T12:00:00Z');
    const onMiddleAfter = edit({ city: { old: 'Portland', new: null } }, OTHER_HOP, '2026-11-13T12:00:00Z');
    const onKeptBefore = edit({ city: { old: 'Portland', new: null } }, KEPT, '2026-11-13T12:00:00Z');
    const onKeptAfter = edit({ city: { old: 'Portland', new: null } }, KEPT, '2026-11-15T12:00:00Z');

    expect(
      editsSinceMerge(
        [onMiddleBefore, onMiddleAfter, onKeptBefore, onKeptAfter],
        { target_id: HOP, created_at: merged },
        KEPT,
        hops,
      ),
    ).toEqual([onMiddleAfter, onKeptAfter]);
  });
});

describe('foldOrder', () => {
  const at = (day: number) => new Date(`2026-11-${day}T12:00:00Z`);

  it('folds a merge through a hop when its row was merged in, right after the merge that brought the row', () => {
    const intoHop = { merge_id: 'into-hop', target_id: HOP, created_at: at(10) };
    const hopIn = { merge_id: 'hop-in', target_id: KEPT, created_at: at(11) };
    const later = { merge_id: 'later', target_id: KEPT, created_at: at(12) };
    const undated = { merge_id: 'undated', target_id: OTHER_HOP, created_at: at(9) };
    const hops = new Map([[HOP, { target_id: KEPT, merged_at: at(11) }]]);

    // As `repair` reads them: merges into the kept person first, oldest first.
    expect(foldOrder([hopIn, later, intoHop, undated], KEPT, hops).map((merge) => merge.merge_id)).toEqual([
      'hop-in',
      'into-hop',
      'later',
      'undated',
    ]);
  });
});

describe('shownByMerge', () => {
  const source = { addresses: [WORK, HOME], street_address: '9 Elm St', city: 'Portland' };
  const flatWork = expect.objectContaining({ label: null, streetAddress: '9 Elm St', city: 'Portland' });

  it("is the source's flat address when the merge left it in the flat fields", () => {
    expect(shownByMerge(source, { addresses: [], street_address: '9 Elm St', city: 'portland ' })).toEqual(
      flatWork,
    );
  });

  it("is nothing when the merge's flat fields show another address", () => {
    // The kept person's own address, or a mix of its city and the source's street.
    expect(shownByMerge(source, { street_address: '5 Oak Ave', city: 'Portland' })).toBeNull();
    expect(shownByMerge(source, { street_address: '9 Elm St', city: 'Salem' })).toBeNull();
    expect(shownByMerge(source, { addresses: [] })).toBeNull();
  });

  it("takes the source's flat address as shown when the merge recorded no bag", () => {
    expect(shownByMerge(source, null)).toEqual(flatWork);
    expect(shownByMerge({ addresses: [HOME] }, null)).toBeNull();
  });
});

describe('offeredAddresses', () => {
  const none = () => false;

  it('offers the list the source had at merge time', () => {
    const snapshot = { addresses: [WORK, HOME], user_edited_keys: ['addresses'] };

    expect(offeredAddresses(snapshot, snapshot, none)).toEqual({ bag: snapshot, leftOff: 0 });
  });

  it("leaves off an address the source's record no longer holds, and one the person removed by hand", () => {
    const { bag, leftOff } = offeredAddresses(
      { addresses: [WORK, HOME] },
      { addresses: [HOME] },
      (address) => address.city === 'Bend',
    );

    expect(bag).toEqual({ addresses: [] });
    expect(leftOff).toBe(1);
  });

  it('keeps a lone value stored in place of the list while the record holds it, as the merge would', () => {
    const snapshot = { addresses: WORK };

    expect(offeredAddresses(snapshot, snapshot, none).bag).toEqual(snapshot);
    expect(offeredAddresses(snapshot, { addresses: HOME }, none).bag).toEqual({});
  });

  it('offers the flat address of a source from before the list, and keeps entries it cannot read only while the record holds them', () => {
    const foreign = { value: '1 Main St, Springfield', type: 'home' };
    const snapshot = { addresses: [foreign], street_address: '9 Elm St', city: 'Portland' };

    expect(offeredAddresses(snapshot, snapshot, none).bag).toEqual(snapshot);
    expect(offeredAddresses(snapshot, { street_address: '9 Elm St', city: 'Portland' }, none).bag).toEqual({
      addresses: [],
      street_address: '9 Elm St',
      city: 'Portland',
    });
  });
});
