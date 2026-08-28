import { TIME_PRECISIONS, TIME_SOURCES } from '@ci/domains/pipeline';

import type { StagedItem } from '../../entities/StagedItemEntity';
import { destinationsFor, toCanonical, type CanonicalRecord } from '../canonical';
import { toContentInput, toEventInput, UNDATED_TIME_PRECISION, UNDATED_TIME_SOURCE } from '../inputs';

/**
 * A record whose SOURCE gave it no time must not end up claiming one.
 *
 * `ci.events.start_time`, `ci.position.time` and `ci.browser_activity.time` are
 * all NOT NULL, so `toCanonical` falls back to the staged row's own `createdAt`
 * — the import wall clock — and marks the substitution with `dated: false`.
 * Everything in this file is about what has to happen next, and every case is a
 * shape that was verified live on a real appliance before it was written down:
 *
 *  - five Google Maps labeled places ("Home", "Work", "Gym", "Gheric", "I've")
 *    sat at the TOP of the timeline sharing one start_time of
 *    2026-08-21T04:56:01.296Z — the instant the run parsed
 *    `Labeled places.json`;
 *  - one of them ALSO donated a `ci.position` row, i.e. a GPS fix asserting the
 *    user's body was at their gym in the middle of that night, which
 *    LocationEstimateService treats as a primary donor;
 *  - two Reddit `moderated_subreddit` rows shared 2026-08-21T04:13:36.050Z;
 *  - one Instagram `recently_viewed_items.html` entry landed in
 *    `ci.browser_activity` dated 2026-08-21T04:13:51.085Z.
 *
 * The split these tests pin down: a table that CAN say the instant is not
 * evidence (`ci.events`, via `time_source`/`time_precision`) keeps the row and
 * marks it; a table that cannot (`ci.position`, `ci.browser_activity`) does not
 * get the row at all.
 */

function stagedRow(overrides: Partial<StagedItem> = {}): StagedItem {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    dataSource: 'google_maps_places',
    classification: null,
    contentHash: 'hash-1',
    occurredAt: new Date('2024-03-02T10:00:00Z'),
    timespanEnd: null,
    latitude: null,
    longitude: null,
    filename: null,
    mediaType: null,
    originalLocation: null,
    intermediateLocation: null,
    metadata: {},
    // The import wall clock. Every `occurredAt: null` case below lands wearing
    // exactly this instant, which is what makes the assertions readable.
    createdAt: new Date('2026-08-21T04:56:01.296Z'),
    ...overrides,
  } as StagedItem;
}

function recordFor(overrides: Partial<StagedItem> = {}): CanonicalRecord {
  return toCanonical(stagedRow(overrides));
}

/** The live shape: a "Home"/"Work"/"Gym" pin out of Takeout's Labeled places.json. */
function labeledPlace(overrides: Partial<StagedItem> = {}): CanonicalRecord {
  return recordFor({
    classification: 'place',
    occurredAt: null,
    latitude: 33.5,
    longitude: -117.7,
    metadata: {
      Title: 'Home',
      Address: '30872 Calle Moraga, Laguna Niguel, CA 92677, USA',
      Kind: 'labeled_place',
      Source: 'Google Maps',
    },
    ...overrides,
  });
}

describe('the import-time fallback is marked, not hidden', () => {
  it('flags a record whose source gave no time', () => {
    expect(labeledPlace().dated).toBe(false);
    expect(labeledPlace().startTime).toBe('2026-08-21T04:56:01.296Z');
  });

  it('leaves a record whose source DID give a time unflagged', () => {
    expect(recordFor({ classification: 'place' }).dated).toBe(true);
  });
});

describe('destinationsFor — no fabricated GPS fix', () => {
  it('keeps an undated saved place on the timeline but off the position table', () => {
    // The event row is what carries the coordinates onto the map, and this
    // appliance has 121 located events in total — dropping four pins to fix a
    // date would be the right answer about time and the wrong one about place.
    // The position row is the opposite: its ONLY content is (lat, lon, time),
    // so without a real time there is nothing honest left to store.
    expect(destinationsFor(labeledPlace())).toEqual(['events']);
  });

  it('still donates the fix when the place IS dated', () => {
    // The guard must be about the missing time, not about saved places.
    const visited = labeledPlace({ occurredAt: new Date('2023-09-30T17:32:23Z') });

    expect(destinationsFor(visited)).toEqual(['events', 'position']);
  });

  it('routes an undated raw GPS fix nowhere at all', () => {
    // A trackpoint has no narrative to keep: it IS (lat, lon, time). PushStage
    // counts a routed-nowhere row under NO_DESTINATION_REASON, so the decision
    // stays visible in the run rather than vanishing into `deduped`.
    const track = recordFor({
      dataSource: 'nmea',
      classification: 'location',
      occurredAt: null,
      latitude: 1,
      longitude: 2,
    });

    expect(destinationsFor(track)).toEqual([]);
  });

  it('strips the position donation from an undated geotagged message', () => {
    // The guard lives above the per-kind branches precisely so kinds nobody
    // thought about are covered too. A communication keeps its own home.
    const geotagged = recordFor({
      dataSource: 'twitter',
      classification: 'message',
      occurredAt: null,
      latitude: 1,
      longitude: 2,
    });

    expect(destinationsFor(geotagged)).toEqual(['communications']);
  });
});

/**
 * The live shape: Instagram's `shopping/recently_viewed_items.html` entry —
 * verified against `ci_import.staged_items` (content_hash
 * 'instagram:recently_viewed_items.html#0'): Title/Type/Source/Description,
 * NO url key. Meta never links a viewed product to a page, so
 * `firstWebLink(html)` returns undefined and `instagram.ts` never stamps
 * `metadata.URL` for this lane — deliberately url-less, not a parser gap (see
 * 20260821024948_cleanup_urlless_instagram_activity_rows.sql, which verifies
 * the same lane URL-less both before and after the permalink fix).
 */
function recentlyViewedItem(overrides: Partial<StagedItem> = {}): CanonicalRecord {
  return recordFor({
    dataSource: 'instagram',
    classification: 'page_view',
    occurredAt: null,
    metadata: {
      Type: 'Instagram recently viewed',
      Title: 'Instagram recently viewed',
      Source: 'Instagram',
      Description: 'Product names Tattoo Balm',
    },
    ...overrides,
  });
}

describe('destinationsFor — no fabricated browsing moment', () => {
  it('routes an undated page view to content instead of browser_activity', () => {
    // ci.browser_activity models "visited X AT TIME T": `time` is NOT NULL, it
    // is the hypertable's partition key, and unlike ci.events there is no
    // time_source column in which to say the instant is not evidence.
    expect(destinationsFor(recentlyViewedItem())).toEqual(['content']);
  });

  it('types that content row as a url-less bookmark rather than the bare kind prefix', () => {
    // What survives an undated visit is the page, not the visit — but this
    // producer never had a page to begin with: only a title survives. 'web' —
    // what the prefix rule would give it — is a bucket nothing renders.
    const input = toContentInput(recentlyViewedItem());

    expect(input).toMatchObject({ type: 'bookmark', title: 'Instagram recently viewed' });
    expect(input.url).toBeUndefined();
  });

  it('leaves a dated page view in browser_activity', () => {
    const viewed = recordFor({
      dataSource: 'chromium',
      classification: 'page_view',
      metadata: { URL: 'https://example.com' },
    });

    expect(destinationsFor(viewed)).toEqual(['browser_activity']);
  });
});

describe('toEventInput — the row an undated event still gets says so', () => {
  it('stamps time_source/time_precision on a saved place', () => {
    const input = toEventInput(labeledPlace());

    // The instant is unchanged — start_time is NOT NULL and there is no date to
    // recover — but nothing downstream can now mistake it for evidence.
    expect(input.start_time).toEqual(new Date('2026-08-21T04:56:01.296Z'));
    expect(input.time_source).toBe(TIME_SOURCES.INGEST);
    expect(input.time_precision).toBe(TIME_PRECISIONS.UNKNOWN);
  });

  it('stamps metadata.undated so a client can render it with no schema change', () => {
    // EventType.metadata is already a GraphQLJSONObject on the wire;
    // time_source has no GraphQL field yet.
    expect(toEventInput(labeledPlace()).metadata).toMatchObject({ undated: true });
  });

  it('stamps a Reddit moderated-subreddit affiliation the same way', () => {
    // The one case that keeps an event home it cannot date: routing it to
    // content would file an empty row, and routing it nowhere would delete the
    // only record that the user moderates r/bitscoop.
    const membership = recordFor({
      dataSource: 'reddit',
      classification: 'social',
      occurredAt: null,
      metadata: { Title: 'r/bitscoop', Subreddit: 'bitscoop', Kind: 'moderated_subreddit' },
    });

    expect(destinationsFor(membership)).toEqual(['events']);
    expect(toEventInput(membership)).toMatchObject({
      time_source: TIME_SOURCES.INGEST,
      time_precision: TIME_PRECISIONS.UNKNOWN,
    });
  });

  it('leaves a dated event NULL rather than claiming `source`', () => {
    // NULL has to keep meaning "unexamined": TemporalRepairStage's candidate
    // set and the `events-timestamped-at-import` doctor check (which excludes
    // time_source = 'source' as its legitimate-shape escape hatch) both depend
    // on it. `dated` only means "the parser produced a non-null instant", which
    // is weaker than "the source supplied it" — a parser that FABRICATES one
    // satisfies the first and violates the second.
    const dated = toEventInput(recordFor({ classification: 'place' }));

    expect(dated.time_source).toBeUndefined();
    expect(dated.time_precision).toBeUndefined();
    expect(dated.metadata).not.toHaveProperty('undated');
  });
});

describe('the mirrored time vocabulary', () => {
  it("matches push/inputs.ts's own copy of the constants TemporalRepairStage declares", () => {
    // push/inputs.ts mirrors these two literals rather than importing them (the
    // import domain has no other dependency on the pipeline domain) and
    // exports them so this comparison can be direct rather than inferred from
    // toEventInput's output. If either copy is renamed or re-valued without
    // the other following, this goes red — the actual failure mode a silent
    // drift would produce, not just a restatement of what TIME_SOURCES.INGEST
    // itself equals.
    expect(UNDATED_TIME_SOURCE).toBe(TIME_SOURCES.INGEST);
    expect(UNDATED_TIME_PRECISION).toBe(TIME_PRECISIONS.UNKNOWN);
  });
});
