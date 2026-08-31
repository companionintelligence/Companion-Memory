import { ObjectCountService, assembleObjectCounts, type RawObjectCountData } from '../ObjectCountService';

/**
 * The picker's "24K Mail" numbers — read from the live `ci.*` tables, never
 * from import run history (see the long docblock on {@link ObjectCountEntry}
 * for why a run's yield cannot honestly be attributed to an object kind).
 *
 * Most of what is worth pinning here is the opposite of what a naive
 * "GROUP BY source_system" would produce: several object kinds needed a
 * per-source predicate rather than a blanket category rule, and the tests
 * below are built from the concrete live-data traps that made that necessary
 * — a LinkedIn tile that would otherwise show a fabricated "2.0K Posts", a
 * Places count that would otherwise double for google_maps_places, an AI
 * source's own 'note' artifacts bleeding into Notes & pages.
 */

function raw(overrides: Partial<RawObjectCountData> = {}): RawObjectCountData {
  return {
    communications: [],
    events: [],
    content: [],
    browserActivity: [],
    receipts: [],
    position: [],
    contacts: 0,
    ...overrides,
  };
}

function commRow(source_system: string, communication_type: string, count: number) {
  return { source_system, communication_type, count: String(count) };
}

function eventRow(source_system: string, event_type: string | null, category: string | null, count: number) {
  return { source_system, event_type, category, count: String(count) };
}

function contentRow(source_system: string, type: string | null, mimetype: string | null, count: number) {
  return { source_system, type, mimetype, count: String(count) };
}

function sourceRow(source_system: string, count: number) {
  return { source_system, count: String(count) };
}

function entryFor(entries: ReturnType<typeof assembleObjectCounts>, importer: string, label: string) {
  return entries.find((e) => e.importer === importer && e.label === label);
}

describe('assembleObjectCounts — communications (Mail / Messages / Conversations)', () => {
  it('sums Mail across every communication_type, including the misfiled receipt-email edge case', () => {
    // COMMUNICATION_TYPE_BY_KIND has no 'commerce.receipt' entry, so the rare
    // HumanCorrespondence receipt-email that does reach ci.communications is
    // stored as communication_type='chat', not 'email' — a type filter would
    // silently undercount Mail by excluding a row that IS mail.
    const entries = assembleObjectCounts(
      raw({ communications: [commRow('gmail', 'chat', 3), commRow('gmail', 'email', 7)] }),
    );

    expect(entryFor(entries, 'gmail', 'Mail')?.count).toBe(10);
  });

  it('sums Messages across chat and call, and never pulls in a social-category source with its own chat rows', () => {
    const entries = assembleObjectCounts(
      raw({
        communications: [
          commRow('google_voice', 'chat', 271_291),
          commRow('google_voice', 'call', 38_390),
          // Twitter DMs — category 'social', not 'messages'. Must not leak in.
          commRow('twitter', 'chat', 4_352),
        ],
      }),
    );

    expect(entryFor(entries, 'google_voice', 'Messages')?.count).toBe(309_681);
    expect(entryFor(entries, 'twitter', 'Messages')).toBeUndefined();
  });

  it('sums Conversations for the AI importers only', () => {
    const entries = assembleObjectCounts(
      raw({ communications: [commRow('claude', 'chat', 4), commRow('grok', 'chat', 16)] }),
    );

    expect(entryFor(entries, 'claude', 'Conversations')?.count).toBe(4);
    expect(entryFor(entries, 'grok', 'Conversations')?.count).toBe(16);
  });
});

describe('assembleObjectCounts — Posts (the per-source dispatch, not a blanket category rule)', () => {
  it('never counts LinkedIn Posts — its only social.post-shaped rows are connections, not posts', () => {
    // The exact live shape that makes this dangerous: linkedin's rows are
    // event_type='social', category='social' — structurally identical to
    // facebook's real posts. Reusing facebook's rule here would show a
    // fabricated "2.0K Posts" on a tile that has never parsed one.
    const entries = assembleObjectCounts(raw({ events: [eventRow('linkedin', 'social', 'social', 1_975)] }));

    expect(entryFor(entries, 'linkedin', 'Posts')).toBeUndefined();
  });

  it('counts facebook/instagram Posts from event_type=social, excluding their like/interaction/media siblings', () => {
    const entries = assembleObjectCounts(
      raw({
        events: [
          eventRow('facebook', 'social', 'social', 59),
          eventRow('facebook', 'media', 'capture', 10),
          eventRow('instagram', 'social', 'social', 5),
          eventRow('instagram', 'like', 'social', 22),
          eventRow('instagram', 'interaction', 'social', 6),
        ],
      }),
    );

    expect(entryFor(entries, 'facebook', 'Posts')?.count).toBe(59);
    expect(entryFor(entries, 'instagram', 'Posts')?.count).toBe(5);
  });

  it("uses mastodon's raw 'post' event_type literal, not 'social' — the same kind, a different stored string", () => {
    const entries = assembleObjectCounts(
      raw({
        events: [eventRow('mastodon', 'post', 'social', 12), eventRow('mastodon', 'social', 'social', 999)],
      }),
    );

    // Only the 'post' literal counts; a stray 'social' row (not mastodon's
    // real shape, but guards against the wrong literal silently working).
    expect(entryFor(entries, 'mastodon', 'Posts')?.count).toBe(12);
  });

  it("excludes reddit's chat DMs from Posts — only communication_type='post' counts", () => {
    const entries = assembleObjectCounts(
      raw({ communications: [commRow('reddit', 'chat', 19), commRow('reddit', 'post', 5)] }),
    );

    expect(entryFor(entries, 'reddit', 'Posts')?.count).toBe(5);
  });

  it('unions twitter Posts across BOTH tables — authored tweets (communications) and retweets (events)', () => {
    const entries = assembleObjectCounts(
      raw({
        communications: [commRow('twitter', 'post', 824), commRow('twitter', 'chat', 4_352)],
        events: [eventRow('twitter', 'social', 'social', 696), eventRow('twitter', 'media', 'capture', 1)],
      }),
    );

    expect(entryFor(entries, 'twitter', 'Posts')?.count).toBe(1_520);
  });
});

describe('assembleObjectCounts — Places (the google_maps_places double-count trap)', () => {
  it("counts google_maps_places' Places ONLY from ci.events, never adding its ci.position rows on top", () => {
    // Live proof this can actually happen: 31 ci.events rows against 9
    // ci.position rows for the very same visits (some have coordinates, some
    // don't — ci.events is the complete leg either way).
    const entries = assembleObjectCounts(
      raw({
        events: [eventRow('google_maps_places', 'place', 'location', 31)],
        position: [sourceRow('google_maps_places', 9), sourceRow('gpx', 4)],
      }),
    );

    expect(entryFor(entries, 'google_maps_places', 'Places')?.count).toBe(31);
    // The raw-GPS importer, meanwhile, has no ci.events leg at all — its full
    // count comes from ci.position alone.
    expect(entryFor(entries, 'gpx', 'Places')?.count).toBe(4);
  });

  it('never mistakes an unrelated event_type/category pair on the same source for a place visit', () => {
    const entries = assembleObjectCounts(
      raw({ events: [eventRow('google_maps_places', 'annotation', 'reading', 67)] }),
    );

    expect(entryFor(entries, 'google_maps_places', 'Places')).toBeUndefined();
  });
});

describe('assembleObjectCounts — Health & activity (there is no literal category "health")', () => {
  it("unions the 'fitness' and 'wearable' categories — ci.events.category is never literally 'health'", () => {
    const entries = assembleObjectCounts(
      raw({
        events: [
          eventRow('google_fit', 'workout', 'fitness', 2_095),
          eventRow('google_fit', 'observation', 'wearable', 1_652),
          eventRow('google_fit', 'location', 'location', 62_832), // RAW_GPS_SOURCES leg — not health
        ],
      }),
    );

    expect(entryFor(entries, 'google_fit', 'Health & activity')?.count).toBe(3_747);
  });
});

describe('assembleObjectCounts — Trips (flighty stays excluded by its own bug)', () => {
  it("counts uber's category='travel' rows and ignores flighty's misclassified category='import' rows", () => {
    // flighty.ts never stamps classification, so kindFor falls through to
    // import.archive_item → category 'import', never 'travel'. The predicate
    // alone already excludes it; this pins that the exclusion list does not
    // accidentally undo that by re-including it some other way.
    const entries = assembleObjectCounts(
      raw({
        events: [
          eventRow('uber', 'trip', 'travel', 79),
          eventRow('uber', 'transaction', 'commerce', 4),
          eventRow('flighty', null, 'import', 12),
        ],
      }),
    );

    expect(entryFor(entries, 'uber', 'Trips')?.count).toBe(79);
    expect(entryFor(entries, 'flighty', 'Trips')).toBeUndefined();
  });
});

describe('assembleObjectCounts — Listening (event_type=listen only)', () => {
  it("excludes spotify's own 'watch' rows (video podcasts) from Listening", () => {
    const entries = assembleObjectCounts(
      raw({
        events: [eventRow('spotify', 'listen', 'media', 118_286), eventRow('spotify', 'watch', 'media', 105)],
      }),
    );

    expect(entryFor(entries, 'spotify', 'Listening')?.count).toBe(118_286);
  });
});

describe('assembleObjectCounts — content (Photos / Videos / Watch history / Bookmarks / Books / Notes / Repositories)', () => {
  it('splits Photos and Videos by mimetype prefix for ANY source with media rows, not just photo-category importers', () => {
    // facebook's category is 'social', not 'photos' — its incidental media
    // still needs a correct count, because the Social object list also
    // renders a 'Photos' chip.
    const entries = assembleObjectCounts(
      raw({
        content: [
          contentRow('facebook', 'media', 'image/jpeg', 5),
          contentRow('facebook', 'media', 'image/png', 1),
          contentRow('facebook', 'media', 'video/mp4', 5),
        ],
      }),
    );

    expect(entryFor(entries, 'facebook', 'Photos')?.count).toBe(6);
    expect(entryFor(entries, 'facebook', 'Videos')?.count).toBe(5);
  });

  it("sums every mimetype for Watch history — youtube's 'like' rows stay excluded by the type='media' filter", () => {
    const entries = assembleObjectCounts(
      raw({
        content: [
          contentRow('youtube', 'media', 'video/mp4', 68_533),
          contentRow('youtube', 'like', null, 1_235),
        ],
      }),
    );

    expect(entryFor(entries, 'youtube', 'Watch history')?.count).toBe(68_533);
  });

  it('keeps Bookmarks and Browsing independent for the same browser importer', () => {
    const entries = assembleObjectCounts(
      raw({
        content: [contentRow('google_chrome', 'bookmark', null, 34)],
        browserActivity: [],
      }),
    );

    expect(entryFor(entries, 'google_chrome', 'Bookmarks')?.count).toBe(34);
    // No visits ever landed for this importer in this fixture — Browsing must
    // not fabricate a zero-labeled entry for it.
    expect(entryFor(entries, 'google_chrome', 'Browsing')).toBeUndefined();
  });

  it('reads Books & highlights from type=annotation for kindle/goodreads and type=media for kindle_reading', () => {
    const entries = assembleObjectCounts(
      raw({
        content: [
          contentRow('kindle', 'annotation', null, 40),
          contentRow('goodreads', 'annotation', null, 12),
          contentRow('kindle_reading', 'media', 'application/x-mobipocket-ebook', 8),
          // A 'media' row on kindle itself must NOT count as a highlight.
          contentRow('kindle', 'media', 'application/x-mobipocket-ebook', 99),
        ],
      }),
    );

    expect(entryFor(entries, 'kindle', 'Books & highlights')?.count).toBe(40);
    expect(entryFor(entries, 'goodreads', 'Books & highlights')?.count).toBe(12);
    expect(entryFor(entries, 'kindle_reading', 'Books & highlights')?.count).toBe(8);
  });

  it("counts Notes & pages only for productivity importers — an AI source's own 'note' artifacts never leak in", () => {
    // Live shape this guards: claude has 5 real ci.content rows with
    // type='note' (custom instructions/canvases). They are not productivity
    // notes, and claude's tile has no Notes & pages chip to put them under.
    const entries = assembleObjectCounts(
      raw({ content: [contentRow('google_keep', 'note', null, 2), contentRow('claude', 'note', null, 5)] }),
    );

    expect(entryFor(entries, 'google_keep', 'Notes & pages')?.count).toBe(2);
    expect(entryFor(entries, 'claude', 'Notes & pages')).toBeUndefined();
  });

  it("counts Repositories from github's starred-repo rows (type='post')", () => {
    const entries = assembleObjectCounts(raw({ content: [contentRow('github', 'post', null, 3)] }));

    expect(entryFor(entries, 'github', 'Repositories')?.count).toBe(3);
  });
});

describe('assembleObjectCounts — Contacts (ci.entities, no source_system column)', () => {
  it("passes the linked_table='import:contact_list' count through under the contact_list importer", () => {
    const entries = assembleObjectCounts(raw({ contacts: 33 }));

    expect(entryFor(entries, 'contact_list', 'Contacts')?.count).toBe(33);
  });

  it('omits Contacts entirely rather than showing a fabricated zero', () => {
    const entries = assembleObjectCounts(raw({ contacts: 0 }));

    expect(entryFor(entries, 'contact_list', 'Contacts')).toBeUndefined();
  });
});

describe('assembleObjectCounts — Calendar (deliberately not ambiguity-filtered here)', () => {
  it("passes the shared 'calendar' importer bucket through — refusing to attribute it to one tile is the frontend's job", () => {
    // google_calendar/apple_calendar/outlook_calendar all share the literal
    // importer 'calendar'; this service answers a true fact about that
    // bucket and leaves unambiguousImporters() (already tested, reused, not
    // reimplemented) to keep it off every tile that shares it.
    const entries = assembleObjectCounts(raw({ events: [eventRow('calendar', 'event', 'calendar', 1_841)] }));

    expect(entryFor(entries, 'calendar', 'Calendar')?.count).toBe(1_841);
  });
});

describe('assembleObjectCounts — never fabricates a zero-count entry', () => {
  it('drops a rule whose every leg summed to zero rather than emitting count: 0', () => {
    const entries = assembleObjectCounts(raw());

    expect(entries).toEqual([]);
  });
});

describe('ObjectCountService.countsForUser — scoping', () => {
  function fakeDataSource(rows: Record<string, unknown[]>) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];

    return {
      calls,
      dataSource: {
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });

          if (sql.includes('ci.communications')) {
            return rows.communications ?? [];
          }

          if (sql.includes('ci.events')) {
            return rows.events ?? [];
          }

          if (sql.includes('ci.content')) {
            return rows.content ?? [];
          }

          if (sql.includes('ci.browser_activity')) {
            return rows.browserActivity ?? [];
          }

          if (sql.includes('ci.receipts')) {
            return rows.receipts ?? [];
          }

          if (sql.includes('ci.position')) {
            return rows.position ?? [];
          }

          if (sql.includes('ci.entities')) {
            return rows.contacts ?? [{ count: '0' }];
          }

          throw new Error(`unexpected query: ${sql}`);
        }),
      },
    };
  }

  it('scopes every query to the caller — user_id (or owner_user_id for entities) as the sole bound parameter', async () => {
    const { dataSource, calls } = fakeDataSource({});
    const service = new ObjectCountService(dataSource as never);

    await service.countsForUser('user-77');

    expect(calls).toHaveLength(7); // 6 tables + the entities lookup
    for (const call of calls) {
      expect(call.params).toEqual(['user-77']);
      expect(call.sql).toMatch(/user_id\s*=\s*\$1/);
    }

    // ci.receipts specifically: user_id, never the nullable household field.
    const receiptsCall = calls.find((c) => c.sql.includes('ci.receipts'));

    expect(receiptsCall?.sql).not.toMatch(/owner_user_id/);
  });

  it('combines the six raw results through the same assembleObjectCounts rules the pure tests pin', async () => {
    const { dataSource } = fakeDataSource({
      communications: [commRow('gmail', 'chat', 5)],
    });
    const service = new ObjectCountService(dataSource as never);

    const entries = await service.countsForUser('user-1');

    expect(entryFor(entries, 'gmail', 'Mail')?.count).toBe(5);
  });
});
