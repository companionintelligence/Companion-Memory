import { ianaZoneForWindowsId, WINDOWS_ZONES } from '../windowsZones';
import { isValidTimezone } from '../zoned';

describe('ianaZoneForWindowsId', () => {
  it.each([
    ['Pacific Standard Time', 'America/Los_Angeles'],
    ['GMT Standard Time', 'Europe/London'],
    ['W. Europe Standard Time', 'Europe/Berlin'],
    ['India Standard Time', 'Asia/Calcutta'],
    ['UTC-08', 'Etc/GMT+8'],
  ])('maps %s to %s', (windowsId, zone) => {
    expect(ianaZoneForWindowsId(windowsId)).toBe(zone);
  });

  it.each([
    ['an IANA id', 'America/Los_Angeles'],
    ['an abbreviation', 'PST'],
    ['a different case', 'pacific standard time'],
    ['an Object prototype key', 'constructor'],
    ['an empty string', ''],
  ])('knows nothing of %s', (_, id) => {
    expect(ianaZoneForWindowsId(id)).toBeUndefined();
  });

  it('maps every Windows id to a zone Intl can read', () => {
    // An entry the runtime cannot read would trade one unreadable zone name
    // for another.
    const unreadable = [...WINDOWS_ZONES].filter(([, zone]) => !isValidTimezone(zone));

    expect(WINDOWS_ZONES.size).toBeGreaterThan(100);
    expect(unreadable).toEqual([]);
  });
});
