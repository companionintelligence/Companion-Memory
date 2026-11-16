import { readPersonAddresses } from '../types';

import { offeredAddresses, removedByHand } from './MergedAddressRepairService';

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

const edit = (changedFields: Record<string, { old?: unknown; new?: unknown }>) => ({
  changed_at: new Date('2026-11-16T12:00:00Z'),
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
