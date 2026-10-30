/**
 * Set-level arithmetic on map pins.
 *
 * These three used to be implicit properties of "the map draws the current page
 * of 30". Now that it draws the whole located set — ten thousand pins on a real
 * library — each one is load-bearing and cheap to get wrong, so they live here
 * as pure functions with tests rather than inline in the view.
 */

/** Minimum a pin has to carry to be placed, ordered or keyed. */
export type PinPoint = { id: string; coords: { lat: number; lng: number } };

/** A placed pin with a real domain timestamp; zero denotes an undated/import-only row. */
export type TimedPinPoint = PinPoint & { sortTime: number };

/** The slice of Leaflet's LatLngBounds this module needs (keeps it DOM-free). */
export interface BoundsLike {
  contains(point: [number, number]): boolean;
  /** West edge in degrees, unwrapped: past ±180 once the view has gone round the globe. */
  getWest(): number;
  getEast(): number;
}

/**
 * The pins inside `bounds`, each at the longitude of whichever copy of the
 * world the viewport is looking at.
 *
 * Clustering is quadratic in the number of clusters it has to de-overlap, and a
 * grid over the whole world at street zoom produces one cluster per pin. Scoping
 * to the viewport bounds that count by the screen instead of by the library:
 * a screen holds a few hundred 80px cells however many pins exist.
 *
 * The world repeats sideways, and a view panned round it reports bounds past
 * ±180° — west 170°, east 190° after one crossing, 530° to 550° after two. A
 * pin at −175° lies in the first of those views, drawn at 185°, and Leaflet
 * puts a marker only where its latLng says, so the copy of the world the
 * person was looking at was bare. Each pin is placed on whichever copy of the
 * world the view's own longitudes name; one copy per pin, because the viewport
 * is never a full world wide (`worldFillMinZoom`), so two copies of a pin can
 * never both be on screen. Nothing jumps the view back (`worldCopyJump` was
 * tried: it recreates every tile on each crossing, a white flash), so the
 * shift can be any number of worlds.
 */
export function pinsInBounds<T extends PinPoint>(pins: T[], bounds: BoundsLike): T[] {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const visible: T[] = [];

  for (const pin of pins) {
    // The copies whose longitude for this pin falls between west and east.
    const first = Math.ceil((west - pin.coords.lng) / 360);
    const last = Math.floor((east - pin.coords.lng) / 360);

    for (let worlds = first; worlds <= last; worlds += 1) {
      const lng = pin.coords.lng + worlds * 360;

      if (bounds.contains([pin.coords.lat, lng])) {
        visible.push(worlds === 0 ? pin : { ...pin, coords: { lat: pin.coords.lat, lng } });
        break;
      }
    }
  }

  return visible;
}

/**
 * The last `max` pins as [lat, lng] pairs, for the route line.
 *
 * `pins` is time-ascending, so this is the most recent stretch. The cap is not
 * cosmetic: the route layer issues one billed Google Directions request per
 * consecutive pair, so an uncapped set would fire one per pin on every load.
 */
export function routePoints(pins: PinPoint[], max: number): Array<[number, number]> {
  return pins.slice(-Math.max(max, 0)).map((pin) => [pin.coords.lat, pin.coords.lng]);
}

/**
 * The latest genuinely dated location.
 *
 * Map pins normally arrive time-ascending, but scanning by timestamp keeps the
 * mobile opening camera correct if an undated/import-only pin is appended.
 */
export function mostRecentDatedPin<T extends TimedPinPoint>(pins: readonly T[]): T | null {
  let latest: T | null = null;

  for (const pin of pins) {
    if (pin.sortTime > 0 && (latest == null || pin.sortTime > latest.sortTime)) {
      latest = pin;
    }
  }

  return latest;
}

/**
 * Identity of a pin set, for deciding whether the viewport should be re-fitted.
 *
 * Changes when the filters change the set, stays put while the user pans within
 * one — the map used to fit its first page and never move again, so every later
 * page landed off-screen. Size plus both endpoints is enough: the set is
 * time-ordered, so a different filter that returned the same count and the same
 * first and last event is the same set for viewport purposes.
 */
export function fitSignature(pins: PinPoint[]): string {
  if (pins.length === 0) {
    return '';
  }

  return `${pins.length}:${pins[0].id}:${pins[pins.length - 1].id}`;
}

/** What the viewport does when a pin set arrives — see {@link fitActionFor}. */
export type FitAction = 'pins' | 'area' | 'none';

/**
 * Decide whether the viewport follows a pin set that just arrived.
 *
 * `fitted` is the signature the viewport was last fitted to (or adopted — see
 * below), null while nothing has been. `areaBound` says the set was fetched
 * with a "Search events in this area" box; `previousAreaBound` says the same of
 * the set before it. `areaChanged` says the boxes differ from the ones the
 * previous set was fetched with, and `areaInView` that at least one of them
 * is on screen (so a box just drawn or resized never re-frames the map).
 *
 *  - A set fetched WITH an area never fits to its pins: the viewport IS the box
 *    the person chose, and fitting to the pins inside it zoomed and re-centred
 *    the map they had just framed, which brought the search button straight
 *    back. It frames the AREA instead, and only when the area is new and not
 *    already on screen — a box just drawn from the viewport is on screen by
 *    definition, while a box that arrived from a saved search ("New Zealand
 *    Trip", opened from San Francisco) is not. This holds for an EMPTY set
 *    too: a search with no hits still has a rectangle to show, and the "no
 *    hits" notice should sit over that rectangle, not over the default city.
 *  - An unchanged set, or an empty one, moves nothing otherwise.
 *  - The first set after an area filter is dropped stays put too. It is the
 *    whole set again, and fitting to it is a fly-back; the person is looking
 *    at where they panned to.
 *  - Anything else — a filter changed the set — fits to the pins, as before.
 */
export function fitActionFor({
  signature,
  fitted,
  areaBound,
  previousAreaBound,
  areaChanged = false,
  areaInView = false,
}: {
  signature: string;
  fitted: string | null;
  areaBound: boolean;
  previousAreaBound: boolean;
  areaChanged?: boolean;
  areaInView?: boolean;
}): FitAction {
  if (areaBound) {
    return areaChanged && !areaInView ? 'area' : 'none';
  }

  if (signature === '' || signature === fitted) {
    return 'none';
  }

  return previousAreaBound ? 'none' : 'pins';
}
