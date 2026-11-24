import {
  type Coordinates,
  type DeliveredLocation,
  type SourceLocation,
  type StoredLocation,
  NO_LOCATION,
  SOURCE_LOCATION_VOCABULARY,
  confidenceOf,
  coordinatesOf,
  heardLocation,
  locationBaseOf,
  locationBaseRecord,
  mergeSourceLocation,
  normalizeLocationName,
  sameLocation,
  showsSourceLocation,
} from '../sourceLocationMerge';

/**
 * The location refresh's whole decision, as tables. The real-Postgres spec
 * (CalendarEventService.sourceLocation.integration.test.ts) proves the rows, the
 * lock, the derived state and the pipeline's re-open; this pins the rule.
 */
const { geocoded, approximate, estimated, reverseGeocoded, placeLinkStage } = SOURCE_LOCATION_VOCABULARY;

const ROMA: Coordinates = [12.4964, 41.9028];
const APPIA: Coordinates = [12.5113, 41.8719];
const USERS: Coordinates = [12.5, 41.9];
const STAGES: Coordinates = [12.6, 41.8];

const place = (name: string | null, coordinates: Coordinates | null = null): SourceLocation => ({
  name,
  coordinates,
});

const CAFE_ROMA = place('Cafe Roma', ROMA);
const CAFE_APPIA = place('Cafe Roma, 12 Via Appia', APPIA);
const NAME_ONLY = place('Cafe Roma');

function shown(
  location: SourceLocation,
  markers: Partial<Pick<StoredLocation, 'source' | 'linked' | 'linkedBy'>> = {},
): StoredLocation {
  return { ...location, source: null, linked: false, linkedBy: null, ...markers };
}

function delivery(location: SourceLocation, confidence: number | null = null): DeliveredLocation {
  return { ...location, confidence };
}

/** A place link `promote.place` wrote. */
const PROMOTED = { linked: true, linkedBy: placeLinkStage } as const;

describe('mergeSourceLocation', () => {
  it('moves a row nobody else touched to where the source moved it, point and name together', () => {
    expect(mergeSourceLocation(shown(CAFE_ROMA), CAFE_ROMA, delivery(CAFE_APPIA, 0.8))).toEqual({
      base: CAFE_APPIA,
      apply: { location: CAFE_APPIA, confidence: 0.8 },
    });
  });

  it('writes nothing when the source repeats itself, even over a user who moved the pin', () => {
    expect(mergeSourceLocation(shown(CAFE_ROMA), CAFE_ROMA, delivery(CAFE_ROMA))).toBeNull();
    expect(mergeSourceLocation(shown(place('Mine', USERS)), CAFE_ROMA, delivery(CAFE_ROMA))).toBeNull();
  });

  it("keeps a user's location, and records what the source said as the new base", () => {
    const mine = place('Mine', USERS);

    expect(mergeSourceLocation(shown(mine), CAFE_ROMA, delivery(CAFE_APPIA))).toEqual({
      base: CAFE_APPIA,
      apply: null,
    });
  });

  it('follows the source again once it agrees with the user, and not before', () => {
    const mine = place('Mine', USERS);

    expect(mergeSourceLocation(shown(mine), CAFE_ROMA, delivery(mine))).toEqual({ base: mine, apply: null });
    expect(mergeSourceLocation(shown(mine), mine, delivery(CAFE_APPIA))).toMatchObject({
      apply: { location: CAFE_APPIA },
    });
  });

  describe('the name and the point are one unit', () => {
    it('clears the point when the name moves to somewhere nobody could place', () => {
      // The provider was down for this delivery, or the text is "TBD": a name,
      // and no point. The old pin belongs to the old name, so it goes.
      const merged = mergeSourceLocation(shown(CAFE_ROMA), CAFE_ROMA, delivery(place('Cafe Appia')));

      expect(merged).toEqual({
        base: place('Cafe Appia'),
        apply: { location: place('Cafe Appia'), confidence: 1 },
      });
    });

    it('clears the whole location when the organizer clears it, or turns it into a meeting link', () => {
      expect(mergeSourceLocation(shown(CAFE_ROMA), CAFE_ROMA, delivery(NO_LOCATION))).toEqual({
        base: NO_LOCATION,
        apply: { location: NO_LOCATION, confidence: 1 },
      });
    });

    it('moves only the name when the delivery keeps the point the row shows', () => {
      const room = place('Room 4', ROMA);
      const renamed = place('Room 4B', ROMA);

      expect(mergeSourceLocation(shown(room), room, delivery(renamed))).toMatchObject({
        apply: { location: renamed },
      });
    });

    it("moves only the point when the name stays (the source's own coordinates changed)", () => {
      expect(
        mergeSourceLocation(shown(CAFE_ROMA), CAFE_ROMA, delivery(place('Cafe Roma', APPIA))),
      ).toMatchObject({
        apply: { location: place('Cafe Roma', APPIA) },
      });
    });

    it('never builds a hybrid: a user who moved the pin keeps the name with it when the source renames', () => {
      const pinMoved = place('Cafe Roma', USERS);

      expect(mergeSourceLocation(shown(pinMoved), CAFE_ROMA, delivery(CAFE_APPIA))?.apply).toBeNull();
    });

    it('never builds a hybrid: a user who renamed keeps the pin with it when the source moves the pin', () => {
      const renamed = place('Mum’s', ROMA);

      expect(
        mergeSourceLocation(shown(renamed), CAFE_ROMA, delivery(place('Cafe Roma', APPIA)))?.apply,
      ).toBeNull();
    });

    it('reads a point as moved when only its latitude, or only its longitude, differs', () => {
      const north = place('Cafe Roma', [ROMA[0], ROMA[1] + 0.001]);
      const east = place('Cafe Roma', [ROMA[0] + 0.001, ROMA[1]]);

      for (const moved of [north, east]) {
        expect(mergeSourceLocation(shown(CAFE_ROMA), CAFE_ROMA, delivery(moved))).toMatchObject({
          apply: { location: moved },
        });
      }
    });

    it('adds a place to an event that had none', () => {
      expect(mergeSourceLocation(shown(NO_LOCATION), NO_LOCATION, delivery(CAFE_ROMA, 0.95))).toEqual({
        base: CAFE_ROMA,
        apply: { location: CAFE_ROMA, confidence: 0.95 },
      });
    });

    it('stores the column default for a point that arrives with no confidence', () => {
      expect(mergeSourceLocation(shown(NO_LOCATION), NO_LOCATION, delivery(CAFE_ROMA, null))).toMatchObject({
        apply: { confidence: 1 },
      });
    });

    it('ignores a confidence the column would refuse', () => {
      for (const bad of [-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(mergeSourceLocation(shown(NO_LOCATION), NO_LOCATION, delivery(CAFE_ROMA, bad))).toMatchObject({
          apply: { confidence: 1 },
        });
      }
    });
  });

  describe('a name without a point, for a name the base already holds', () => {
    it('is a geocoder that could not place it this time, not the source clearing the pin', () => {
      // The row, the base and the delivery's name agree; only the point is
      // missing from the delivery. Nothing moves, and the base keeps its point.
      expect(mergeSourceLocation(shown(CAFE_ROMA), CAFE_ROMA, delivery(NAME_ONLY))).toBeNull();
    });

    it('does not wipe a pin the user moved either', () => {
      expect(
        mergeSourceLocation(shown(place('Cafe Roma', USERS)), CAFE_ROMA, delivery(NAME_ONLY)),
      ).toBeNull();
    });

    it('keeps the base point when the same name comes back placed differently only after a gap', () => {
      // Outage delivery, then recovery: the second one lands against a base that
      // still holds the point.
      expect(mergeSourceLocation(shown(CAFE_ROMA), CAFE_ROMA, delivery(NAME_ONLY))).toBeNull();
      expect(
        mergeSourceLocation(shown(CAFE_ROMA), CAFE_ROMA, delivery(place('Cafe Roma', APPIA))),
      ).toMatchObject({
        apply: { location: place('Cafe Roma', APPIA) },
      });
    });

    it('still clears the point when there is no name for the base to match', () => {
      // No name means no geocoder was ever asked: the source really sent nothing.
      const pointOnly = place(null, ROMA);

      expect(mergeSourceLocation(shown(pointOnly), pointOnly, delivery(NO_LOCATION))).toMatchObject({
        apply: { location: NO_LOCATION },
      });
    });
  });

  describe('a row with no base (NULL source_location)', () => {
    it('reads as the default, "the source said nothing": a row with no location follows its source', () => {
      expect(mergeSourceLocation(shown(NO_LOCATION), null, delivery(CAFE_ROMA))).toMatchObject({
        base: CAFE_ROMA,
        apply: { location: CAFE_ROMA },
      });
    });

    it("keeps a location the row shows, which may be a person's, and records the base", () => {
      expect(mergeSourceLocation(shown(CAFE_ROMA), null, delivery(CAFE_APPIA))).toEqual({
        base: CAFE_APPIA,
        apply: null,
      });
    });

    it('records the base even when the source says what the row shows', () => {
      expect(mergeSourceLocation(shown(CAFE_ROMA), null, delivery(CAFE_ROMA))).toEqual({
        base: CAFE_ROMA,
        apply: null,
      });
      expect(mergeSourceLocation(shown(NO_LOCATION), null, delivery(NO_LOCATION))).toEqual({
        base: NO_LOCATION,
        apply: null,
      });
    });

    it('does not read a point-less delivery as keeping a point it never had a base for', () => {
      expect(mergeSourceLocation(shown(NO_LOCATION), null, delivery(NAME_ONLY))).toMatchObject({
        apply: { location: NAME_ONLY },
      });
    });
  });

  it('applies to a row that already shows what the source now says by moving only the base', () => {
    // The stage geocoded the name the source held; the source now delivers the
    // same name with the same point it would have: nothing about the row moves.
    expect(
      mergeSourceLocation(shown(CAFE_ROMA, { source: geocoded }), NAME_ONLY, delivery(CAFE_ROMA)),
    ).toEqual({ base: CAFE_ROMA, apply: null });
  });

  it('never stores a location it was not given: the row keeps its own, or takes what was heard', () => {
    const rows = [
      shown(CAFE_ROMA),
      shown(place('Mine', USERS)),
      shown(NO_LOCATION),
      shown(CAFE_ROMA, { source: geocoded }),
      shown(place(null, ROMA), { source: estimated }),
      shown(CAFE_ROMA, PROMOTED),
    ];
    const bases = [null, NO_LOCATION, NAME_ONLY, CAFE_ROMA, CAFE_APPIA];
    const deliveries = [
      NO_LOCATION,
      NAME_ONLY,
      CAFE_ROMA,
      CAFE_APPIA,
      place(null, ROMA),
      place('Elsewhere', USERS),
    ];

    for (const row of rows) {
      for (const base of bases) {
        for (const delivered of deliveries) {
          const merged = mergeSourceLocation(row, base, delivery(delivered));

          if (merged?.apply) {
            expect(sameLocation(merged.apply.location, heardLocation(base, delivered))).toBe(true);
            expect(sameLocation(merged.apply.location, row)).toBe(false);
          }

          if (merged) {
            expect(sameLocation(merged.base, heardLocation(base, delivered))).toBe(true);
          }
        }
      }
    }
  });
});

describe('showsSourceLocation', () => {
  describe('what the stages wrote counts as the source’s, narrowly', () => {
    it('enrich.geocode: the point it placed for the name the base holds', () => {
      for (const tag of [geocoded, approximate]) {
        expect(showsSourceLocation(shown(CAFE_ROMA, { source: tag }), NAME_ONLY)).toBe(true);
      }
    });

    it('enrich.geocode: not for a name that moved since, or a base that already had a point', () => {
      // The user renamed it after the stage placed the old name.
      expect(showsSourceLocation(shown(place('Mine', ROMA), { source: geocoded }), NAME_ONLY)).toBe(false);
      // The stage does not overwrite a point it does not own, so it did not write this one.
      expect(showsSourceLocation(shown(place('Cafe Roma', USERS), { source: geocoded }), CAFE_ROMA)).toBe(
        false,
      );
    });

    it('enrich.geocode: not for a point on a row with no name to have placed', () => {
      expect(showsSourceLocation(shown(place(null, ROMA), { source: geocoded }), NO_LOCATION)).toBe(false);
    });

    it('enrich.estimate_location: a borrowed point on an event with no location of its own', () => {
      expect(showsSourceLocation(shown(place(null, ROMA), { source: estimated }), NO_LOCATION)).toBe(true);
    });

    it('enrich.estimate_location: an estimate under a name the base also holds, which the stage’s first version wrote', () => {
      // A neighbour's point is as much the pipeline's under a name as without one.
      expect(showsSourceLocation(shown(place('Cafe Roma', STAGES), { source: estimated }), NAME_ONLY)).toBe(
        true,
      );
    });

    it('enrich.estimate_location: not on a row that has a name, or when the source had a point', () => {
      expect(showsSourceLocation(shown(CAFE_ROMA, { source: estimated }), NO_LOCATION)).toBe(false);
      expect(showsSourceLocation(shown(place(null, USERS), { source: estimated }), place(null, ROMA))).toBe(
        false,
      );
    });

    it('enrich.event_reverse: the name it derived from the point the base holds', () => {
      expect(
        showsSourceLocation(
          shown(place('Via Appia 12', ROMA), { source: reverseGeocoded }),
          place(null, ROMA),
        ),
      ).toBe(true);
    });

    it('enrich.event_reverse: not when the base had a name, or the point moved', () => {
      expect(
        showsSourceLocation(
          shown(place('Mine', ROMA), { source: reverseGeocoded }),
          place('Cafe Roma', ROMA),
        ),
      ).toBe(false);
      expect(
        showsSourceLocation(
          shown(place('Via Appia 12', USERS), { source: reverseGeocoded }),
          place(null, ROMA),
        ),
      ).toBe(false);
    });

    it('promote.place: a link it wrote is derived from the pair, so it does not count against the row', () => {
      expect(showsSourceLocation(shown(CAFE_ROMA, PROMOTED), CAFE_ROMA)).toBe(true);
    });

    it('a link anything else wrote reads as a choice, so the location is not the source’s', () => {
      expect(showsSourceLocation(shown(CAFE_ROMA, { linked: true }), CAFE_ROMA)).toBe(false);
      expect(
        showsSourceLocation(shown(CAFE_ROMA, { linked: true, linkedBy: 'someone.else' }), CAFE_ROMA),
      ).toBe(false);
    });

    it('a tag on a row that matches the base changes nothing', () => {
      for (const tag of [geocoded, approximate, estimated, reverseGeocoded, 'virtual']) {
        expect(showsSourceLocation(shown(CAFE_ROMA, { source: tag }), CAFE_ROMA)).toBe(true);
      }
    });

    it('a tag the pipeline does not write is not evidence of anything', () => {
      expect(showsSourceLocation(shown(CAFE_ROMA, { source: 'user' }), NAME_ONLY)).toBe(false);
    });
  });

  it('is false the moment either half differs from the base without a stage to account for it', () => {
    expect(showsSourceLocation(shown(place('Mine', ROMA)), CAFE_ROMA)).toBe(false);
    expect(showsSourceLocation(shown(place('Cafe Roma', USERS)), CAFE_ROMA)).toBe(false);
    expect(showsSourceLocation(shown(NO_LOCATION), CAFE_ROMA)).toBe(false);
  });
});

describe('heardLocation', () => {
  it('is the delivery when it carries a point', () => {
    expect(heardLocation(CAFE_ROMA, CAFE_APPIA)).toEqual(CAFE_APPIA);
    expect(heardLocation(null, CAFE_APPIA)).toEqual(CAFE_APPIA);
  });

  it('keeps the base point for a name it already holds', () => {
    expect(heardLocation(CAFE_ROMA, NAME_ONLY)).toEqual(CAFE_ROMA);
  });

  it('does not invent a point for a name it does not', () => {
    expect(heardLocation(CAFE_ROMA, place('Elsewhere'))).toEqual(place('Elsewhere'));
    expect(heardLocation(null, NAME_ONLY)).toEqual(NAME_ONLY);
    expect(heardLocation(place(null, ROMA), NO_LOCATION)).toEqual(NO_LOCATION);
  });
});

describe('the value helpers', () => {
  it('normalizeLocationName keeps text verbatim and calls blank no name', () => {
    expect(normalizeLocationName('  Cafe Roma ')).toBe('  Cafe Roma ');
    for (const blank of [null, undefined, '', '   ', '\n\t', 5]) {
      expect(normalizeLocationName(blank)).toBeNull();
    }
  });

  it('coordinatesOf reads only a usable GeoJSON Point', () => {
    expect(coordinatesOf({ type: 'Point', coordinates: [12.5, 41.9] })).toEqual([12.5, 41.9]);

    const unusable: Array<Parameters<typeof coordinatesOf>[0]> = [
      null,
      undefined,
      { type: 'Polygon', coordinates: [12.5, 41.9] },
      { type: 'Point' },
      { type: 'Point', coordinates: [12.5] },
      { type: 'Point', coordinates: ['12.5', '41.9'] },
      { type: 'Point', coordinates: [Number.NaN, 41.9] },
      { type: 'Point', coordinates: [181, 41.9] },
      { type: 'Point', coordinates: [12.5, -91] },
    ];

    for (const point of unusable) {
      expect(coordinatesOf(point)).toBeNull();
    }
  });

  it('confidenceOf accepts what the CHECK accepts', () => {
    expect([0, 0.4, 1].map(confidenceOf)).toEqual([0, 0.4, 1]);
    expect([null, undefined, '0.5', -1, 2, Number.NaN].map(confidenceOf)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('round-trips the base column, and reads anything else as no base', () => {
    for (const location of [CAFE_ROMA, NAME_ONLY, place(null, ROMA), NO_LOCATION]) {
      const record = JSON.parse(JSON.stringify(locationBaseRecord(location)));

      expect(locationBaseOf(record)).toEqual(location);
    }

    for (const notABase of [null, undefined, 'x', 3, [], [1, 2]]) {
      expect(locationBaseOf(notABase)).toBeNull();
    }
  });
});
