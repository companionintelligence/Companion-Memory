import { BadRequestException } from '@nestjs/common';

import { MAX_BULK_INPUT_SIZE, MaxArraySizePipe } from '../MaxArraySizePipe';

describe('MaxArraySizePipe', () => {
  it('passes an array at exactly the cap through unchanged', () => {
    const pipe = new MaxArraySizePipe(3);
    const value = [1, 2, 3];

    expect(pipe.transform(value)).toBe(value);
  });

  it('passes an under-cap array through unchanged', () => {
    const pipe = new MaxArraySizePipe(3);
    const value = [1];

    expect(pipe.transform(value)).toBe(value);
  });

  it('rejects an oversized array with a 400 that names both sizes', () => {
    const pipe = new MaxArraySizePipe(3);

    expect(() => pipe.transform([1, 2, 3, 4])).toThrow(BadRequestException);
    expect(() => pipe.transform([1, 2, 3, 4])).toThrow(/4 items exceeds the maximum of 3/);
  });

  it('defaults to MAX_BULK_INPUT_SIZE and rejects one element over it', () => {
    const pipe = new MaxArraySizePipe();
    const oversized = Array.from({ length: MAX_BULK_INPUT_SIZE + 1 }, () => 0);

    expect(() => pipe.transform(oversized)).toThrow(BadRequestException);
    // At the default cap exactly, it passes.
    const atCap = Array.from({ length: MAX_BULK_INPUT_SIZE }, () => 0);
    expect(pipe.transform(atCap)).toBe(atCap);
  });

  it('leaves a non-array value untouched (defers to other validation)', () => {
    const pipe = new MaxArraySizePipe(3);
    const value = { not: 'an array' } as unknown as unknown[];

    expect(pipe.transform(value)).toBe(value);
  });
});
