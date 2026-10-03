/**
 * The location refresh for events a source owns, as pure functions — the same
 * three-way merge `sourceStatusMerge.ts` applies to `status` and
 * `sourceFieldMerge.ts` to the time and the title, for the one field that is
 * really a cluster of columns with several writers.
 *
 * A calendar connection re-delivers a meeting when its organizer changes the
 * place: "Cafe Roma" becomes "Cafe Roma, 12 Via Appia", or a street address
 * becomes a Zoom link, or a place is added to an event that had none. The stored
 * row keeps its first-sync location for good unless the refresh lands the new
 * one, and it cannot simply overwrite the row, because the location is also
 * everybody else's:
 *
 *  - `update` writes `location_name`, `location_coordinates` and
 *    `location_entity_id`, so a user (or an agent) who corrected the pin must
 *    keep it when the organizer edits the agenda;
 *  - `enrich.geocode` writes coordinates for a name the transform could not
 *    place, `enrich.event_reverse` a name for a point, and
 *    `enrich.estimate_location` a borrowed point for an event with no location
 *    of its own;
 *  - `promote.place` turns a name and a point into a link to a Location, which
 *    the edge leg turns into an Event −LOCATED_AT→ Place edge.
 *
 * So the field keeps beside it what its SOURCE delivered last time — its merge
 * base — and a re-delivery is a three-way merge: the row still shows the base →
 * nobody else touched it, and the new location lands; the row shows anything
 * else → someone else changed it, and that stands; either way the delivery
 * becomes the new base.
 *
 * ── The unit: a name and a point, merged together ───────────────────────────
 *
 * The source's location is `{ name, coordinates }`, and the two move as ONE
 * value. The tempting alternative, a merge per column, is wrong in the case
 * that matters most, and this is the argument for never moving `location_name`
 * alone.
 *
 * The point on a calendar row is not a second fact. It is what a geocoder
 * answered for the name (the Google transform geocodes the text before it
 * builds the row; `enrich.geocode` does it later for a name the transform could
 * not place). Move the name and keep the point, and the row says "Cafe B" on
 * "Cafe A"'s pin. That is worse than leaving both stale, in three ways:
 *
 *  1. Stale is consistent. The pin matches the name, both are a meeting ago,
 *     and the source's next edit still lands. A split row is wrong twice, and
 *     nothing on it says so.
 *  2. Nothing ever repairs it. The point is untagged, so as far as the
 *     pipeline can tell it is a source's or a person's, not its own:
 *     `enrich.geocode` records `coordinates_not_owned` and never looks at the
 *     name again, `enrich.event_reverse` records `name_not_owned`, and
 *     `promote.place` keeps the link it made for the old point. A stale row is
 *     at least eligible for the next move; a split one is eligible for nothing.
 *  3. It poisons what is computed from the pair. The Place the row links to,
 *     its LOCATED_AT edge, the place's visit counts and footprint, and Known
 *     places (which labels a cluster with its most common `location_name`) all
 *     describe the OLD point under the NEW name.
 *
 * So the name alone is safe in exactly one case, and it is not a special case:
 * the delivery's point is the one the row already shows (an Outlook room whose
 * displayName gains a letter and keeps its coordinates). Then the unit's
 * coordinates are unchanged, and applying the unit moves only the name. In
 * every other case the unit replaces both columns in one statement. A name that
 * moved to a place nobody could geocode this time (the provider is down, the
 * text is "TBD") leaves the row with a name and NO point, which is the shape
 * `enrich.geocode` exists to fill; the refresh re-opens it.
 *
 * Merging the unit also settles who wins when two people touch different halves.
 * A user who moved the pin and an organizer who renamed the venue produce no
 * hybrid: the user's edit of either half makes the whole location theirs, as a
 * user who moved the end of a meeting has moved the meeting (sourceFieldMerge.ts).
 *
 * ── What counts as the source's: stage-written values ───────────────────────
 *
 * The base is what the SOURCE said. Four pipeline writers put values on the row
 * that the source never sent, and a row carrying one of them still shows its
 * source, exactly as a row `clean.temporal_repair` moved still follows its
 * source. Each stage tags what it writes (`metadata.location_source`, and
 * `metadata.promote.stage` for the link) in the same statement as the value, so
 * the tag is evidence about who wrote the value, and each is read narrowly:
 *
 *  - `geocoded` / `approximate` (`enrich.geocode`): the point is the geocode of
 *    the NAME the row carries, which is the base's (the name is compared on
 *    its own). Counts only while the base has no point of its own: the stage
 *    never overwrites a point it does not own, so a base with a point cannot
 *    have been replaced by it. And only on a row that has a name to have
 *    placed.
 *  - `estimated` (`enrich.estimate_location`): a point borrowed from a
 *    neighbour. Counts only while the base has no point of its own. It is not
 *    derived from anything the source said, which is why a delivery that adds a
 *    place replaces it. (The stage only estimates a row with no name; an
 *    estimate under a name is the residue of its first version, and is as
 *    much a neighbour's point as any other.)
 *  - `reverse_geocoded` (`enrich.event_reverse`, or the legacy listener's
 *    reverse leg): the NAME is derived from the point. Counts only for a base
 *    with no name; the point is compared on its own, so it must still be the
 *    base's.
 *  - `metadata.promote.stage = 'promote.place'`, or no link at all: the place
 *    link is derived from the pair, and withdrawn with it. A link anything else
 *    wrote (`update`, the legacy geocode listener, an importer) carries no
 *    marker and reads as a person's choice, so the location stands.
 *
 * What is NOT recognised, and so stands: a point or a link written by a path
 * that leaves no tag. The legacy `GeocodeBatchListener` tags only its coarse
 * hits, so a row it geocoded precisely reads as someone else's. That fails
 * stale, never wrong, and it is the status quo.
 *
 * A tag must not outlive the edit that supersedes it, or a person's correction
 * would read as the pipeline's: a user who fixes a point the geocoder got wrong
 * would see the organizer's next edit replace it. So `update` takes the marks a
 * person's write supersedes out of `metadata` in the same statement
 * (`metadataWithoutSupersededMarks` in CalendarEventService): a point replaces
 * the tags that describe a point, a name the one that describes a name, a link
 * the link's marker. That also stops `enrich.geocode` and `enrich.event_reverse`
 * from overwriting the correction at their next version.
 *
 * ── Where the base lives ────────────────────────────────────────────────────
 *
 * `ci.events.source_location` (20261001171454), one nullable jsonb value:
 * `{"name": string | null, "coordinates": [lng, lat] | null}`. NULL is "no base"
 * (a row stored before bases existed, or one the backfill could not clear of a
 * person's edit), and the object with both members null is "the source delivered
 * no location": two meanings, which a column per half cannot spell without a
 * third column to say whether a base exists at all. A coordinate pair is
 * compared as two JSON numbers, and an app-written number round-trips through
 * jsonb exactly.
 *
 * A NULL base reads as "the source has said nothing", the default, which is how
 * #2890 reads a NULL `source_status`. A row that shows no location at all
 * therefore follows its source (an event first synced with no place that gets
 * one later), while a row that shows one stands, because it may be a person's.
 *
 * ── What a delivery without a point means ───────────────────────────────────
 *
 * The Google transform builds the point by geocoding the name, and a provider
 * that is down, rate-limited or switched off returns none. So a delivery with
 * a NAME and no point, for the name the base already holds, is not the source
 * clearing a pin: it is a geocoder that could not place a name it placed
 * before. Treating it as a move would wipe a good coordinate on an unchanged
 * place because of an outage. It leaves the base's point in the base and the
 * row alone ({@link heardLocation}). Only a changed name, or no name at all
 * (the organizer cleared the place, or replaced it with a meeting link, which
 * the transforms drop), clears the point.
 */

/** `[longitude, latitude]` — the order GeoJSON and PostGIS use. */
export type Coordinates = readonly [longitude: number, latitude: number];

/** The location a source states: a name, a point, both, or neither. */
export interface SourceLocation {
  name: string | null;
  coordinates: Coordinates | null;
}

/** What a source that says nothing about the place delivers, and what a NULL base reads as. */
export const NO_LOCATION: SourceLocation = { name: null, coordinates: null };

/** One delivery's location, with the confidence it attached to its point (Google's geocode precision). */
export interface DeliveredLocation extends SourceLocation {
  confidence: number | null;
}

/** What a row shows, with the markers that say who wrote it. */
export interface StoredLocation extends SourceLocation {
  /** `metadata.location_source`: the tag the pipeline stamps on a value it wrote. */
  source: string | null;
  /** Whether `location_entity_id` is set. */
  linked: boolean;
  /** `metadata.promote.stage`: which stage wrote the link, when one did. */
  linkedBy: string | null;
}

/** What the merge moves the row to. */
export interface AppliedLocation {
  location: SourceLocation;
  /** `confidence_score` for the new point: the delivery's, or the column DEFAULT. */
  confidence: number;
}

export interface LocationMerge {
  /** The new merge base: what the delivery said. */
  base: SourceLocation;
  /** What the row moves to; null when the row is left as it is and only the base moves. */
  apply: AppliedLocation | null;
}

/**
 * The pipeline's vocabulary for `metadata.location_source` and
 * `metadata.promote.stage`, which this file reads. Declared by the stages
 * (`GeocodeStage`, `EventReverseStage`, `EstimateLocationStage`,
 * `PlacePromoteStage`) and copied here because memory cannot import the
 * pipeline; `pipeline/__tests__/sourceLocationVocabulary.spec.ts` fails when a
 * copy drifts, which would turn a recognised tag into an unrecognised one
 * without a sound.
 */
export const SOURCE_LOCATION_VOCABULARY = {
  geocoded: 'geocoded',
  approximate: 'approximate',
  estimated: 'estimated',
  reverseGeocoded: 'reverse_geocoded',
  placeLinkStage: 'promote.place',
} as const;

/** `ci.events.confidence_score`'s column DEFAULT, which a point-less event carries. */
export const DEFAULT_LOCATION_CONFIDENCE = 1;

/** A name as the merge compares it: blank is no name, anything else is kept verbatim. */
export function normalizeLocationName(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * The `[lng, lat]` of a GeoJSON Point, or null when it is not a usable one:
 * a delivery whose point cannot be written says no point.
 */
export function coordinatesOf(
  point: { type?: string; coordinates?: unknown } | null | undefined,
): Coordinates | null {
  if (point?.type !== 'Point' || !Array.isArray(point.coordinates) || point.coordinates.length < 2) {
    return null;
  }

  const [longitude, latitude] = point.coordinates as unknown[];

  if (
    typeof longitude !== 'number' ||
    typeof latitude !== 'number' ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90
  ) {
    return null;
  }

  return [longitude, latitude];
}

/** A `confidence_score` the column accepts (a CHECK holds it to [0, 1]), or null. */
export function confidenceOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
}

export function sameCoordinates(left: Coordinates | null, right: Coordinates | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return left[0] === right[0] && left[1] === right[1];
}

export function sameLocation(left: SourceLocation, right: SourceLocation): boolean {
  return left.name === right.name && sameCoordinates(left.coordinates, right.coordinates);
}

/** The base column's jsonb, as the merge reads it; null when there is no base or it is not one. */
export function locationBaseOf(stored: unknown): SourceLocation | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return null;
  }

  const { name, coordinates } = stored as { name?: unknown; coordinates?: unknown };

  return {
    name: normalizeLocationName(name),
    coordinates: coordinatesOf(Array.isArray(coordinates) ? { type: 'Point', coordinates } : null),
  };
}

/** A location as the base column stores it. */
export function locationBaseRecord(location: SourceLocation): {
  name: string | null;
  coordinates: number[] | null;
} {
  return { name: location.name, coordinates: location.coordinates ? [...location.coordinates] : null };
}

/**
 * What a delivery amounts to against the base: the delivery, except that a name
 * the base already holds, delivered without a point, keeps the base's point
 * (see "What a delivery without a point means").
 */
export function heardLocation(base: SourceLocation | null, delivered: SourceLocation): SourceLocation {
  if (delivered.coordinates !== null) {
    return { name: delivered.name, coordinates: delivered.coordinates };
  }

  const sameName = base !== null && delivered.name !== null && base.name === delivered.name;

  return { name: delivered.name, coordinates: sameName ? base.coordinates : null };
}

/**
 * Whether the row shows its source's last location: nothing but the source and
 * the pipeline, working from what the source said, has written it.
 *
 * Every clause below is evidence of one writer's work and is narrow on purpose:
 * a tag counts for the difference its stage can make and for no other.
 */
export function showsSourceLocation(row: StoredLocation, base: SourceLocation): boolean {
  // A link nobody can account for is somebody's choice, so the location is theirs.
  if (row.linked && row.linkedBy !== SOURCE_LOCATION_VOCABULARY.placeLinkStage) {
    return false;
  }

  // The name and the point are judged apart, and both must pass. Each clause below
  // is only as wide as the stage that wrote it, and relies on the other half to
  // hold the rest: a derived name passes only beside the base's own point, a
  // derived point only beside the base's own name.
  const samePoint = sameCoordinates(row.coordinates, base.coordinates);

  // `enrich.event_reverse` names a point; it never names a row that has a name.
  const nameIsSources =
    row.name === base.name ||
    (row.source === SOURCE_LOCATION_VOCABULARY.reverseGeocoded && base.name === null);

  // A stage placed the base's name, or lent a neighbour's point; neither ever
  // replaces a point the source delivered.
  const pointIsSources =
    samePoint ||
    (base.coordinates === null &&
      ((row.name !== null &&
        (row.source === SOURCE_LOCATION_VOCABULARY.geocoded ||
          row.source === SOURCE_LOCATION_VOCABULARY.approximate)) ||
        row.source === SOURCE_LOCATION_VOCABULARY.estimated));

  return nameIsSources && pointIsSources;
}

/**
 * Merge a location the source just delivered into a row's current one.
 *
 * A NULL base reads as {@link NO_LOCATION}: the row follows its source only if
 * it shows no location, and a row that shows one may be a person's and stands.
 *
 * @returns what to store, or `null` when the source repeated itself (the
 *   delivery amounts to the base it already has).
 */
export function mergeSourceLocation(
  row: StoredLocation,
  base: SourceLocation | null,
  delivered: DeliveredLocation,
): LocationMerge | null {
  const heard = heardLocation(base, delivered);

  if (base !== null && sameLocation(base, heard)) {
    return null;
  }

  // Either someone else wrote the row's location, or the row already shows what
  // the source now says: the base moves and the row does not.
  if (!showsSourceLocation(row, base ?? NO_LOCATION) || sameLocation(row, heard)) {
    return { base: heard, apply: null };
  }

  return {
    base: heard,
    apply: {
      location: heard,
      confidence:
        heard.coordinates === null
          ? DEFAULT_LOCATION_CONFIDENCE
          : (confidenceOf(delivered.confidence) ?? DEFAULT_LOCATION_CONFIDENCE),
    },
  };
}
