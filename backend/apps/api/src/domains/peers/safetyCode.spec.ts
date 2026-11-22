import { safetyCodeFor } from './safetyCode';

const A = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const B = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
const C = 'did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf';

describe('safety codes', () => {
  it('is the same from either side', () => {
    expect(safetyCodeFor(A, B)).toBe(safetyCodeFor(B, A));
  });

  it('is twelve digits in three groups', () => {
    expect(safetyCodeFor(A, B)).toMatch(/^\d{4} \d{4} \d{4}$/);
  });

  it('differs when either key differs: a swapped invite shows', () => {
    expect(safetyCodeFor(A, C)).not.toBe(safetyCodeFor(A, B));
    expect(safetyCodeFor(C, B)).not.toBe(safetyCodeFor(A, B));
  });
});
