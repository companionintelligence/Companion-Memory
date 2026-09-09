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
  // for `NavUserMenu` — the Theme / Log out cluster, with Settings beside
  // Profile in the same submenu.
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
    expect(isRailDestinationActive(byId.memory, '/plan/calendar')).toBe(false);
  });

  // Chat moved under Memory (/memory/chat) — a thread deep-link has to keep
  // the Memory row lit the same way a person detail page already does.
  it('treats a Chat thread deep-link as Memory', () => {
    expect(isRailDestinationActive(byId.memory, '/memory/chat')).toBe(true);
    expect(isRailDestinationActive(byId.memory, '/memory/chat/abc123')).toBe(true);
  });

  // Planning is one rail destination covering both sub-views — Tasks and
  // Calendar — plus Calendar's own card deep-links.
  it('treats both Plan sub-views, and Calendar card deep-links, as Planning', () => {
    expect(byId.plan.to).toBe('/plan');
    expect(isRailDestinationActive(byId.plan, '/plan')).toBe(true);
    expect(isRailDestinationActive(byId.plan, '/plan/tasks')).toBe(true);
    expect(isRailDestinationActive(byId.plan, '/plan/calendar')).toBe(true);
    expect(isRailDestinationActive(byId.plan, '/plan/calendar/a1')).toBe(true);
    expect(isRailDestinationActive(byId.plan, '/forecast')).toBe(false);
  });

  it('treats Sources children as Sources', () => {
    expect(isRailDestinationActive(byId.sources, '/sources/connect')).toBe(true);
    expect(isRailDestinationActive(byId.sources, '/plan')).toBe(false);
  });
});

/**
 * Sources has always had three halves — Services, Import, Devices — and the
 * rail offered only the question. Reaching Devices meant landing on Services
 * and knowing a switch existed above the fold.
 */
describe('Sources submenu', () => {
  const sources = () => allRailDestinations().find((d) => d.id === 'sources');

  it('carries the three halves the page has, in the page order', () => {
    expect(sources()?.children?.map((child) => child.label)).toEqual(['Services', 'Import', 'Devices']);
  });

  it('points each row at the route the page actually serves', () => {
    expect(sources()?.children?.map((child) => child.to)).toEqual([
      '/sources/connect',
      '/sources/import',
      '/sources/devices',
    ]);
  });

  /**
   * A gated ROUTE in this app is never registered rather than blocked, so with
   * `import.page` off `/sources/import` redirects back to Services. A row that
   * survived the flag would be a link that silently lands somewhere else.
   */
  it('drops the Import row when its flag is off, keeping the other two', () => {
    const visible = visibleRailDestinations((flag) => flag !== 'import.page');
    const labels = visible.find((d) => d.id === 'sources')?.children?.map((c) => c.label);

    expect(labels).toEqual(['Services', 'Devices']);
  });

  it('keeps Import when the flag is on', () => {
    const visible = visibleRailDestinations(() => true);

    expect(visible.find((d) => d.id === 'sources')?.children?.map((c) => c.label)).toContain('Import');
  });

  /**
   * `/sources` normalises to the connect half (SourcesPage redirects), so the
   * bare route must light Services up — otherwise landing on /sources shows a
   * rail with nothing selected while Services is plainly on screen.
   */
  it('lights Services up on the bare /sources route as well as its own', () => {
    const services = sources()?.children?.find((child) => child.label === 'Services');

    expect(services?.match?.('/sources')).toBe(true);
    expect(services?.match?.('/sources/connect')).toBe(true);
    expect(services?.match?.('/sources/devices')).toBe(false);
  });

  it('does not light one half up on another half’s route', () => {
    const [services, importRow, devices] = sources()?.children ?? [];

    expect(importRow?.match?.('/sources/devices')).toBe(false);
    expect(devices?.match?.('/sources/import')).toBe(false);
    expect(services?.match?.('/sources/import')).toBe(false);
  });
});
