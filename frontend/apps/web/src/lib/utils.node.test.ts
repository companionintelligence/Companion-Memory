import { describe, expect, it } from 'vitest';

import { cn, getMediaType } from './utils';

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('drops falsy / conditional values', () => {
    const show = true as boolean;
    const hide = false as boolean;
    expect(cn('a', false, null, undefined, 0 as unknown as string, 'b')).toBe('a b');
    expect(cn('a', show && 'b', hide && 'c')).toBe('a b');
  });

  it('dedupes conflicting Tailwind utilities (last wins)', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-sm', 'text-lg')).toBe('text-lg');
  });
});

describe('getMediaType', () => {
  it('classifies image / video / audio mimetypes', () => {
    expect(getMediaType('image/png')).toBe('image');
    expect(getMediaType('video/mp4')).toBe('video');
    expect(getMediaType('audio/mpeg')).toBe('audio');
  });

  it.each([
    ['application/pdf', 'application/pdf'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('returns null for %s', (_label, input) => {
    expect(getMediaType(input)).toBeNull();
  });
});
