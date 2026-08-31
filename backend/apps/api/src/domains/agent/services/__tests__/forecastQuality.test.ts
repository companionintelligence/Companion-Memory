import { clusterPasses, displayNameFor, isDisplayableLabel, occupancyLabelOk } from '../forecastQuality';

describe('forecastQuality', () => {
  it('rejects UNKNOWN, short crumbs, slug collisions, and news-like tokens', () => {
    expect(isDisplayableLabel('UNKNOWN')).toBe(false);
    expect(isDisplayableLabel('Drs')).toBe(false);
    expect(isDisplayableLabel('Too')).toBe(false);
    expect(isDisplayableLabel('Air_2')).toBe(false);
    expect(isDisplayableLabel('Ransom')).toBe(false);
    expect(isDisplayableLabel('Activist')).toBe(false);
    expect(isDisplayableLabel('Riot')).toBe(false);
    expect(isDisplayableLabel('No Think')).toBe(false);
  });

  it('keeps real L0 classes and named stretches', () => {
    expect(isDisplayableLabel('WORK')).toBe(true);
    expect(isDisplayableLabel('standup')).toBe(true);
    expect(isDisplayableLabel('beach trip')).toBe(true);
    expect(occupancyLabelOk('WORK', 0.7)).toBe(true);
    expect(occupancyLabelOk('WORK', 0.1)).toBe(false);
    expect(occupancyLabelOk('UNKNOWN', 1)).toBe(false);
  });

  it('lets booked calendar through the probability floor, not junk names', () => {
    expect(clusterPasses({ name: 'Dentist', l0_class: 'ERRAND', p_occur: 0.05, scheduled: true })).toBe(true);
    expect(clusterPasses({ name: 'Drs', l0_class: 'UNKNOWN', p_occur: 0.9 })).toBe(false);
    expect(clusterPasses({ name: 'No Think', l0_class: 'LEISURE', p_occur: 0.8 })).toBe(false);
    expect(clusterPasses({ name: 'Deep Focus', l0_class: 'WORK', p_occur: 0.2 })).toBe(false);
    expect(displayNameFor({ name: 'Drs', l0_class: 'WORK', p_occur: 1, scheduled: true })).toBe('WORK');
  });
});
