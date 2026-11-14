import { describe, expect, it } from 'vitest';

import { fitPadding } from './framing';

describe('fitPadding', () => {
  it('leaves 60px all round when nothing covers the map', () => {
    expect(fitPadding()).toEqual({ paddingTopLeft: [60, 60], paddingBottomRight: [60, 60] });
  });

  it('adds the width of a panel over the left edge to the left side only', () => {
    expect(fitPadding(300)).toEqual({ paddingTopLeft: [360, 60], paddingBottomRight: [60, 60] });
  });

  it('takes a different edge, keeping the panel on the left', () => {
    expect(fitPadding(300, 0)).toEqual({ paddingTopLeft: [300, 0], paddingBottomRight: [0, 0] });
  });
});
