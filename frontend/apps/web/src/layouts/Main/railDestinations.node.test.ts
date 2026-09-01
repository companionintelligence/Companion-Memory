import { describe, expect, it } from 'vitest';

import {
  RAIL_DESTINATIONS,
  allRailDestinations,
  isRailDestinationActive,
  visibleRailDestinations,
} from './railDestinations';

describe('visibleRailDestinations', () => {
  it('keeps ungated rows in order, with Asks folded under Saved Searches', () => {
    const visible = visibleRailDestinations(() => true);

    expect(visible.map((destination) => destination.id)).toEqual([
      'plan',
      'calendar',
      'memory',
      'saved-searches',
      'sources',
      'jobs',
      'forecast',
      'self',
    ]);
    expect(visible.find((d) => d.id === 'saved-searches')?.children?.map((c) => c.id)).toEqual(['asks']);
  });

  // ═══ THE ACCOUNT TILE IS NOT A STATISTICS PAGE ═══
  //
  // Self used to be gated on `stats.page`, and the tile is the ONLY mount point
  // for `NavUserMenu` — the only Settings / Theme / Log out cluster in the app.
  // Turning off a flag named for a statistics page therefore removed the user's
  // avatar, their whole identity surface, the theme switcher, Settings, and
  // every way to sign out. Both directions are asserted, because it is the
  // second one that was the bug.
  it('keeps the account tile when only the stats page is turned off', () => {
    const visible = visibleRailDestinations((flag) => flag !== 'stats.page');

    expect(visible.map((destination) => destination.id)).toContain('self');
  });

  it('drops the account tile only for its own flag', () => {
    const visible = visibleRailDestinations((flag) => flag !== 'self.page');

    expect(visible.map((destination) => destination.id)).not.toContain('self');
  });

  // Share (a link I mint) and Ask (a request they mint) are both a bounded
  // search run as me. Two peer rows read as two unrelated places. One group,
  // one row — Chat itself moved under Memory, not into this group.
  it('carries Asks inside the Saved Searches group rather than as a peer row', () => {
    const visible = visibleRailDestinations(() => true);
    const ids = visible.map((destination) => destination.id);

    expect(ids).not.toContain('chat');
    expect(ids).not.toContain('asks');
    expect(visible.find((d) => d.id === 'saved-searches')?.children?.map((c) => c.id)).toEqual(['asks']);
  });

  // Grouping is a layout decision; it must not become a second gate. Asks
  // rides its own flag independently of its group head (which, unlike the
  // old Chat group, is itself ungated and can never go dark).
  it('drops Asks from the group when `ask` is off but keeps Saved Searches', () => {
    const visible = visibleRailDestinations((flag) => flag !== 'ask');

    expect(visible.map((destination) => destination.id)).toContain('saved-searches');
    expect(visible.find((d) => d.id === 'saved-searches')?.children).toEqual([]);
    expect(allRailDestinations().map((d) => d.id)).toContain('asks');
  });

  it('gates Forecast on `forecast.page` — the same flag the /forecast route checks', () => {
    const forecast = RAIL_DESTINATIONS.find((destination) => destination.id === 'forecast');

    expect(forecast?.flag).toBe('forecast.page');
    expect(forecast?.to).toBe('/forecast');
    expect(visibleRailDestinations((flag) => flag !== 'forecast.page').map((d) => d.id)).not.toContain(
      'forecast',
    );
    expect(visibleRailDestinations(() => true).map((d) => d.id)).toContain('forecast');
  });

  it('gates Asks on `ask` — the flag the /asks route itself checks', () => {
    // /asks was reachable only by typing the URL. The row has to ride the same
    // flag as the route: the route is not REGISTERED when `ask` is off, so a
    // row gated on anything else would render a link to a 404.
    const asks = allRailDestinations().find((destination) => destination.id === 'asks');

    expect(asks?.flag).toBe('ask');
    expect(asks?.to).toBe('/asks');
    // Scoped to Asks by id. This used to assert the rail had NO children at all
    // once `ask` was off, which only held while Asks was the single child in the
    // whole rail — Jobs now carries its sections and categories the same way, so
    // the broad form failed on an unrelated change instead of on this contract.
    const withoutAsk = visibleRailDestinations((flag) => flag !== 'ask');

    expect(withoutAsk.flatMap((d) => d.children ?? []).map((child) => child.id)).not.toContain('asks');
    expect(withoutAsk.map((d) => d.id)).not.toContain('asks');
    // Still proves the gate is real: with every flag on, Asks IS a child.
    expect(
      visibleRailDestinations(() => true)
        .flatMap((d) => d.children ?? [])
        .map((child) => child.id),
    ).toContain('asks');
  });
});

describe('isRailDestinationActive', () => {
  const byId = Object.fromEntries(allRailDestinations().map((destination) => [destination.id, destination]));

  it('treats Memory hub and legacy people routes as Memory', () => {
    expect(byId.memory.to).toBe('/memory');
    expect(isRailDestinationActive(byId.memory, '/memory')).toBe(true);
    expect(isRailDestinationActive(byId.memory, '/memory/people')).toBe(true);
    expect(isRailDestinationActive(byId.memory, '/people/abc')).toBe(true);
    expect(isRailDestinationActive(byId.memory, '/calendar')).toBe(false);
  });

  // Chat moved under Memory (/memory/chat) — a thread deep-link has to keep
  // the Memory row lit the same way a person detail page already does.
  it('treats a Chat thread deep-link as Memory', () => {
    expect(isRailDestinationActive(byId.memory, '/memory/chat')).toBe(true);
    expect(isRailDestinationActive(byId.memory, '/memory/chat/abc123')).toBe(true);
  });

  it('treats Calendar card deep-links as Calendar', () => {
    expect(isRailDestinationActive(byId.calendar, '/calendar')).toBe(true);
    expect(isRailDestinationActive(byId.calendar, '/calendar/a1')).toBe(true);
    expect(isRailDestinationActive(byId.calendar, '/forecast')).toBe(false);
  });

  it('treats Sources children as Sources', () => {
    expect(isRailDestinationActive(byId.sources, '/sources/connect')).toBe(true);
    expect(isRailDestinationActive(byId.sources, '/plan')).toBe(false);
  });
});
