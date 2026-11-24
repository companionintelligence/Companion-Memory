import { LIVE_EVENT_SQL } from './CalendarEventService';
import { EVENT_HAPPENED_SQL, RESERVATION_CANCELED_KEY } from './eventHappened';

/**
 * The fragment's behaviour is proven against Postgres, in
 * `KnownPlacesService.integration.spec.ts` and
 * `PlaceService.visitStats.integration.spec.ts`. This pins its text. A change
 * that Postgres cannot tell apart today still has to be a decision: `IS NOT
 * TRUE` and a COALESCE on a column that is NOT NULL select the same rows, so
 * no database test can notice either one going. Their down migrations drop the
 * constraint, and the text is what keeps the rule right after that.
 */
describe('EVENT_HAPPENED_SQL', () => {
  it('is the four clauses, in one parenthesis, over the `event` alias', () => {
    expect(EVENT_HAPPENED_SQL).toBe(
      '(event.is_deleted IS NOT TRUE' +
        ' AND event.is_predicted IS NOT TRUE' +
        ` AND ${LIVE_EVENT_SQL}` +
        " AND COALESCE(event.metadata->>'Canceled', '') <> 'true')",
    );
  });

  it("applies the calendar's own status test, interpolated rather than copied", () => {
    expect(LIVE_EVENT_SQL).toContain('event.status');
    expect(EVENT_HAPPENED_SQL).toContain(LIVE_EVENT_SQL);
    // A module cycle would interpolate `undefined` into both sides of the
    // comparison above, and it would still pass.
    expect(EVENT_HAPPENED_SQL).not.toContain('undefined');
  });

  it('COALESCEs the reservation key, which is NULL on nearly every row', () => {
    // `metadata` defaults to '{}', so a bare `<> 'true'` is NULL for every row
    // without the key and would drop all of them.
    expect(EVENT_HAPPENED_SQL).toContain("COALESCE(event.metadata->>'Canceled', '') <> 'true'");
  });

  it('treats a NULL is_predicted as not predicted, and a NULL is_deleted as not deleted', () => {
    expect(EVENT_HAPPENED_SQL).toContain('event.is_predicted IS NOT TRUE');
    expect(EVENT_HAPPENED_SQL).toContain('event.is_deleted IS NOT TRUE');
  });

  it('takes no bind parameters, so a query can use it without renumbering its own', () => {
    expect(EVENT_HAPPENED_SQL).not.toMatch(/\$\d/);
  });

  it('is one parenthesised group, so it is as safe after an OR as after an AND', () => {
    let depth = 0;
    let closedAt = -1;

    for (const [index, char] of [...EVENT_HAPPENED_SQL].entries()) {
      depth += char === '(' ? 1 : char === ')' ? -1 : 0;

      if (depth === 0) {
        closedAt = index;
        break;
      }
    }

    // The first parenthesis closes at the very end, not part-way through.
    expect(closedAt).toBe(EVENT_HAPPENED_SQL.length - 1);
  });

  it("names the key the Takeout importer writes, because it is a copy of the importer's", () => {
    expect(RESERVATION_CANCELED_KEY).toBe('Canceled');
  });
});
