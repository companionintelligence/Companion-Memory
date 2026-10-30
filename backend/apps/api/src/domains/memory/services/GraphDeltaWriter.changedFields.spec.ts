import { changedFieldsBetween } from './GraphDeltaWriter';

describe('changedFieldsBetween', () => {
  it('keeps only the keys whose value moved, as old and new', () => {
    expect(
      changedFieldsBetween(
        { nickname: 'Rob', job_title: null, website: 'https://a.example' },
        { nickname: 'Robbie', job_title: 'Tester', website: 'https://a.example' },
        ['nickname', 'job_title', 'website'],
      ),
    ).toEqual({ nickname: { old: 'Rob', new: 'Robbie' }, job_title: { old: null, new: 'Tester' } });
  });

  it('treats missing, null and empty text as the same empty value', () => {
    expect(changedFieldsBetween({ a: null, b: '' }, { a: '', c: null }, ['a', 'b', 'c'])).toEqual({});
  });

  it('treats an empty list as empty too, so [] replacing a missing value is not a change', () => {
    expect(changedFieldsBetween({}, { addresses: [] }, ['addresses'])).toEqual({});
    expect(changedFieldsBetween({ addresses: null }, { addresses: [] }, ['addresses'])).toEqual({});
    expect(changedFieldsBetween({ addresses: [] }, { addresses: '' }, ['addresses'])).toEqual({});
  });

  it('still records a list that gained or lost entries, an emptied one as null', () => {
    expect(changedFieldsBetween({}, { addresses: ['1 Main St'] }, ['addresses'])).toEqual({
      addresses: { old: null, new: ['1 Main St'] },
    });
    expect(changedFieldsBetween({ addresses: ['1 Main St'] }, { addresses: [] }, ['addresses'])).toEqual({
      addresses: { old: ['1 Main St'], new: null },
    });
  });

  it('drops a field whose old and new value are the same', () => {
    expect(changedFieldsBetween({ name: 'Robin Hale' }, { name: 'Robin Hale' }, ['name'])).toEqual({});
  });

  it('records a cleared value as null', () => {
    expect(changedFieldsBetween({ a: 'x' }, { a: '' }, ['a'])).toEqual({ a: { old: 'x', new: null } });
  });

  it('compares objects by content, whatever their key order', () => {
    expect(changedFieldsBetween({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }, ['a'])).toEqual({});
    expect(changedFieldsBetween({ a: [1, 2] }, { a: [2, 1] }, ['a'])).toEqual({
      a: { old: [1, 2], new: [2, 1] },
    });
  });
});
