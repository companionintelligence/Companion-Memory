import { describe, expect, it } from 'vitest';

import {
  dueItemVisible,
  isDisplayableLabel,
  placeVisible,
  weekClusterVisible,
} from './forecastDisplay';

describe('forecastDisplay', () => {
  it('hides junk tokenizer names from week and due rows', () => {
    expect(isDisplayableLabel('Drs')).toBe(false);
    expect(isDisplayableLabel('No Think')).toBe(false);
    expect(
      weekClusterVisible({ name: 'Drs', l0Class: 'UNKNOWN', pOccur: 0.9, scheduled: false }),
    ).toBe(false);
    expect(
      weekClusterVisible({ name: 'Deep Focus', l0Class: 'WORK', pOccur: 0.9, scheduled: false }),
    ).toBe(true);
    expect(dueItemVisible({ name: 'See Friends' })).toBe(true);
    expect(dueItemVisible({ name: 'Too' })).toBe(false);
    expect(placeVisible({ label: 'home', probability: 0.4 })).toBe(true);
    expect(placeVisible({ label: '', probability: 0.9 })).toBe(false);
    expect(placeVisible({ label: 'office', probability: 0.1 })).toBe(false);
  });
});
