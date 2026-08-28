/**
 * The editing shape behind {@link PlaceForm}, and the conversion to the
 * GraphQL `CreatePlaceInput`.
 *
 * Kept beside the form (rather than in the modal) for the same reason as
 * {@link ../PersonForm/personDraft}: the coordinate parsing and the
 * blank-field rules are worth testing on their own, and any later edit flow
 * has to agree with the add flow about what an empty field means.
 */

/**
 * The place kinds the server accepts. Mirrors PLACE_KINDS in the backend
 * PlaceResolver, which rejects anything else outright (there is a matching
 * `valid_place_kind` CHECK on the table) — so this list is a closed set and a
 * `select`, not a free-text suggestion list.
 */
export const PLACE_KINDS = [
  'room',
  'building',
  'venue',
  'address',
  'neighborhood',
  'city',
  'region',
  'country',
  'continent',
  'planet',
  'other',
] as const;

export type PlaceKind = (typeof PLACE_KINDS)[number];

/** Display names for {@link PLACE_KINDS} — shared by the places list and the form. */
export const PLACE_KIND_LABELS: Record<string, string> = {
  room: 'Room',
  building: 'Building',
  venue: 'Venue',
  address: 'Address',
  neighborhood: 'Neighborhood',
  city: 'City',
  region: 'Region',
  country: 'Country',
  continent: 'Continent',
  planet: 'Planet',
  other: 'Place',
};

export interface PlaceDraft {
  name: string;
  /** One of {@link PLACE_KINDS}, or '' for "unspecified". */
  placeKind: string;
  description: string;
  /** Stored on `properties.address`, which is what the detail drawer edits. */
  address: string;
  /** Decimal degrees, as typed. Blank unless the user fills both. */
  latitude: string;
  longitude: string;
}

/** Persist a GPS fix without rounding away the pin. Seven decimals is ~1 cm. */
export function formatExactCoordinate(value: number): string {
  if (!Number.isFinite(value)) {
    return '';
  }

  return value.toFixed(7);
}

/**
 * Apply a device GPS fix to the draft: exact lat/lng, address when reverse
 * geocode found one, and a name/kind only when the user has not set them yet.
 */
export function applyCurrentLocation(
  draft: PlaceDraft,
  fix: { latitude: number; longitude: number; address?: string | null },
): PlaceDraft {
  const address = fix.address?.trim() ?? '';
  const nameIsPlaceholder = draft.name.trim() === '' || draft.name.trim() === 'Current location';

  return {
    ...draft,
    latitude: formatExactCoordinate(fix.latitude),
    longitude: formatExactCoordinate(fix.longitude),
    address: address === '' ? draft.address : address,
    name: nameIsPlaceholder ? (address === '' ? 'Current location' : address) : draft.name,
    placeKind: draft.placeKind === '' ? 'address' : draft.placeKind,
  };
}

export function emptyPlaceDraft(): PlaceDraft {
  return {
    name: '',
    placeKind: '',
    description: '',
    address: '',
    latitude: '',
    longitude: '',
  };
}

/** Parsed coordinates, or null unless BOTH parts are present and in range. */
export function parseCoordinates(
  latitude: string,
  longitude: string,
): { latitude: number; longitude: number } | null {
  if (latitude.trim() === '' || longitude.trim() === '') {
    return null;
  }

  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { latitude: lat, longitude: lng };
}

export type PlaceDraftProblem = 'name' | 'coordinates';

/** What stops this draft from being saved, in field order. Null when it's good. */
export function validatePlaceDraft(draft: PlaceDraft): PlaceDraftProblem | null {
  if (draft.name.trim() === '') {
    return 'name';
  }

  // Half a coordinate pair is silently dropped by parseCoordinates, and a place
  // missing from the map reads as data loss — reject it instead.
  const hasSomeCoordinate = draft.latitude.trim() !== '' || draft.longitude.trim() !== '';

  if (hasSomeCoordinate && parseCoordinates(draft.latitude, draft.longitude) == null) {
    return 'coordinates';
  }

  return null;
}

/**
 * The `CreatePlaceInput` for a draft. Blank optional fields are omitted rather
 * than sent as empty strings — this is a create, and `placeKind: ''` would be
 * rejected outright by the resolver's kind check.
 *
 * `latitude`/`longitude` are sent as their own fields, not inside `properties`:
 * the resolver writes them to the typed `location_point` column, which is
 * canonical, and explicitly does not accept `properties.geolocation`.
 *
 * Throws when the draft is invalid — callers check {@link validatePlaceDraft}
 * first and render the message.
 */
export function placeDraftToInput(draft: PlaceDraft) {
  const name = draft.name.trim();

  if (name === '') {
    throw new Error('A place needs a name');
  }

  const coordinates = parseCoordinates(draft.latitude, draft.longitude);
  const address = draft.address.trim();
  const description = draft.description.trim();
  const placeKind = draft.placeKind.trim();

  return {
    name,
    description: description === '' ? undefined : description,
    placeKind: placeKind === '' ? undefined : placeKind,
    // The detail drawer reads and writes the address from `properties.address`;
    // matching it here keeps a hand-made place editable the same way.
    properties: address === '' ? undefined : { address },
    latitude: coordinates?.latitude,
    longitude: coordinates?.longitude,
  };
}
