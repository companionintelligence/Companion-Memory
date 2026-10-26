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
