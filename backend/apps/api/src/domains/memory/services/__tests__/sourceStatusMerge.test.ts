import { DEFAULT_EVENT_STATUS, mergeSourceStatus } from '../sourceStatusMerge';

/**
 * The status refresh's whole decision, as a table. The real-Postgres specs
 * (CalendarEventService.sourceStatus.integration.test.ts and the Google
 * transform's cancellation spec) prove the rows; this pins the rule.
 */
describe('mergeSourceStatus', () => {
  it.each([
    // [row status, base, delivered] → [status, statusChanged]; the new base is
    // always what was delivered.
    ['the source cancels what it confirmed', 'confirmed', 'confirmed', 'cancelled', 'cancelled', true],
    ['the source restores what it cancelled', 'cancelled', 'cancelled', 'confirmed', 'confirmed', true],
    ['a tentative meeting is confirmed', 'tentative', 'tentative', 'confirmed', 'confirmed', true],
    ["the user's no_show stands", 'no_show', 'confirmed', 'cancelled', 'no_show', false],
    [
      "the user's tentative stands against a cancel",
      'tentative',
      'confirmed',
      'cancelled',
      'tentative',
      false,
    ],
    // The user cancelled first and the source agreed: the conflict is over,
    // and the new base lets the source's next change through.
    ['the user and the source converge', 'cancelled', 'confirmed', 'cancelled', 'cancelled', false],
  ])('%s', (_case, status, sourceStatus, delivered, nextStatus, statusChanged) => {
    expect(mergeSourceStatus({ status, sourceStatus }, delivered)).toEqual({
      status: nextStatus,
      sourceStatus: delivered,
      statusChanged,
    });
  });

  it('lets the source through again once the user and it have converged', () => {
    expect(mergeSourceStatus({ status: 'cancelled', sourceStatus: 'confirmed' }, 'cancelled')).toMatchObject({
      status: 'cancelled',
      sourceStatus: 'cancelled',
    });

    // The organizer reinstates the meeting the user had already written off.
    expect(mergeSourceStatus({ status: 'cancelled', sourceStatus: 'cancelled' }, 'confirmed')).toEqual({
      status: 'confirmed',
      sourceStatus: 'confirmed',
      statusChanged: true,
    });
  });

  it('writes nothing when the source repeats itself — the usual re-delivery', () => {
    expect(mergeSourceStatus({ status: 'confirmed', sourceStatus: 'confirmed' }, 'confirmed')).toBeNull();
    // Even when the user has diverged: there is no new information.
    expect(mergeSourceStatus({ status: 'no_show', sourceStatus: 'confirmed' }, 'confirmed')).toBeNull();
  });

  describe('a row no source ever asserted a status for (NULL base)', () => {
    it('reads the base as the column default, which is what the row was given', () => {
      expect(DEFAULT_EVENT_STATUS).toBe('confirmed');
      expect(mergeSourceStatus({ status: 'confirmed', sourceStatus: null }, 'cancelled')).toEqual({
        status: 'cancelled',
        sourceStatus: 'cancelled',
        statusChanged: true,
      });
    });

    it('keeps any other status: only a user could have put it there', () => {
      expect(mergeSourceStatus({ status: 'tentative', sourceStatus: null }, 'cancelled')).toEqual({
        status: 'tentative',
        sourceStatus: 'cancelled',
        statusChanged: false,
      });
    });

    it('records the first base even when nothing visible moves', () => {
      expect(mergeSourceStatus({ status: 'confirmed', sourceStatus: null }, 'confirmed')).toEqual({
        status: 'confirmed',
        sourceStatus: 'confirmed',
        statusChanged: false,
      });
    });
  });
});
