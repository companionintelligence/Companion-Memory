import { resolvePageShape, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './keysetPaginate';

describe('resolvePageShape', () => {
  it('uses first for forward pagination', () => {
    expect(resolvePageShape({ first: 10 })).toEqual({ limit: 10, isBackward: false });
  });

  it('treats last/before as backward', () => {
    expect(resolvePageShape({ last: 5 })).toEqual({ limit: 5, isBackward: true });
    expect(resolvePageShape({ beforeId: 'x' })).toEqual({ limit: DEFAULT_PAGE_SIZE, isBackward: true });
  });

  it('defaults page size when neither first nor last is given', () => {
    expect(resolvePageShape({})).toEqual({ limit: DEFAULT_PAGE_SIZE, isBackward: false });
    expect(resolvePageShape({ afterId: 'x' })).toEqual({ limit: DEFAULT_PAGE_SIZE, isBackward: false });
  });

  it('clamps an over-large request to MAX_PAGE_SIZE', () => {
    expect(resolvePageShape({ first: 100_000 }).limit).toBe(MAX_PAGE_SIZE);
    expect(resolvePageShape({ last: 100_000 }).limit).toBe(MAX_PAGE_SIZE);
  });

  it('never returns a negative limit', () => {
    expect(resolvePageShape({ first: -5 }).limit).toBe(0);
  });
});
