/**
 * The searched map areas: the rectangles a search is confined to, drawn on
 * the map, and the tools that make them.
 *
 * The URL is the source of truth (`?areas=`, see bbox.ts): every rectangle
 * here is rendered FROM it, and every drawing, edit or removal writes back to
 * it, so the explorer feed, the pins, the chip in the drop area and a saved
 * search all read one list. Several rectangles are ORed by the server — a trip
 * to London and Paris is two boxes, not one over the Channel.
 *
 * Drawing, moving and resizing come from leaflet-geoman. Its own toolbar is
 * never shown; the map's top bar drives it, so the controls look like the rest
 * of the map's. In draw mode the rectangle tool stays on after each box, so a
 * trip is several drags; in edit mode every rectangle grows corner handles and
 * can be dragged whole, and a remove handle sits at its top-right corner.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';

import L from 'leaflet';
import { Marker, Rectangle, useMap as useLeafletMap } from 'react-leaflet';
import { useSearchParams } from 'react-router-dom';

import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

import {
  AREAS_PARAM,
  boundsToBbox,
  formatAreas,
  LEGACY_BBOX_PARAM,
  readAreasParam,
  type Bbox,
} from '../bbox';

/** What the area tools are doing: drawing new rectangles, editing the existing ones, or nothing. */
export type AreaMode = 'draw' | 'edit' | null;

const AREA_STYLE: L.PathOptions = {
  color: 'rgb(21, 93, 252)',
  weight: 2,
  opacity: 0.8,
  dashArray: '8, 6',
  fill: true,
  fillOpacity: 0.04,
};
const INERT_AREA_STYLE: L.PathOptions = { ...AREA_STYLE, interactive: false };

/** The searched areas in the URL, and a setter that writes them back (replacing the entry, like a pan). */
export function useSearchAreas(): [Bbox[], (next: Bbox[]) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(AREAS_PARAM);
  const legacy = searchParams.get(LEGACY_BBOX_PARAM);
  // Keyed on the param text, not the params object, which react-router
  // recreates on every navigation: callers memoise on the list identity.
  const areas = useMemo(
    () =>
      readAreasParam(
        new URLSearchParams({ ...(raw ? { areas: raw } : {}), ...(legacy ? { bbox: legacy } : {}) }),
      ) ?? [],
    [raw, legacy],
  );

  const setAreas = useCallback(
    (next: Bbox[]) => {
      setSearchParams(
        (params) => {
          if (next.length > 0) {
            params.set(AREAS_PARAM, formatAreas(next));
            // Not paired with `hasLocation`: the server ORs the rectangles
            // with the Where names, so a named place without coordinates is
            // still a match, and a forced located-only flag would drop it.
            // The Map tab's own default (applyViewFilterDefaults) and the
            // person's switch are the only writers of that flag.
          } else {
            params.delete(AREAS_PARAM);
          }

          // Whatever an old link carried is superseded by the list.
          params.delete(LEGACY_BBOX_PARAM);

          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [areas, setAreas];
}

// Anchored so the button floats just OUTSIDE the rectangle's top-right
// corner: geoman's corner handle sits exactly on the corner, and a button on
// the same spot either covered the handle or hid behind it, depending on
// which was added last.
const REMOVE_ICON = L.divIcon({
  className: 'memory-map-area-remove',
  html: '<span aria-hidden="true">×</span>',
  iconSize: [22, 22],
  iconAnchor: [-8, 30],
});

function toBounds([minLon, minLat, maxLon, maxLat]: Bbox): L.LatLngBoundsExpression {
  return [
    [minLat, minLon],
    [maxLat, maxLon],
  ];
}

/** One rectangle. Editable ones get geoman's corner handles, whole-shape drag, and a remove handle. */
function AreaRectangle({
  area,
  editable,
  onEdit,
  onRemove,
}: {
  area: Bbox;
  editable: boolean;
  onEdit: (next: Bbox) => void;
  onRemove: () => void;
}) {
  const ref = useRef<L.Rectangle>(null);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;

  useEffect(() => {
    const layer = ref.current;

    if (layer == null || !editable) {
      return;
    }

    // The rectangle is created inert (see `pathOptions` below) and made
    // interactive here, IN PLACE, for the length of the edit: Leaflet fixes
    // `interactive` at creation, and re-creating the layer to flip it is not
    // an option — geoman unhooks itself the moment its layer leaves the map
    // (`layer.on('remove', disable)`), and React's StrictMode simulates
    // exactly that unmount for every layer that mounts in dev, which left the
    // four corner handles created and then gone within the same tick.
    const path = (layer as unknown as { _path?: SVGElement })._path;

    if (path != null) {
      layer.options.interactive = true;
      path.classList.add('leaflet-interactive');
      layer.addInteractiveTarget(path as unknown as HTMLElement);
    }

    // geoman's edit mode: the four corner handles. Its layer-drag mode is a
    // SEPARATE mode that switches editing off (`enableLayerDrag()` starts
    // with `disable()`), and the `draggable` option only matters there — so
    // the whole-rectangle drag below is this file's own, running alongside
    // the handles rather than instead of them.
    const EDIT_OPTIONS = { allowSelfIntersection: false, draggable: false };
    layer.pm.enable(EDIT_OPTIONS);

    // Every edit ends in the same place: the layer's bounds are the new box.
    // Writing it to the URL remounts this rectangle under a new key, which
    // is fine — the handles come straight back on the new layer.
    const commit = () => onEditRef.current(boundsToBbox(layer.getBounds()));
    layer.on('pm:edit', commit);

    // Drag the body: a press anywhere inside the rectangle (the handles sit
    // above it and take their own presses) moves the whole box by the
    // pointer's travel, in degrees, so it keeps its size at every latitude.
    // The map must not pan underneath — its own drag starts from the same
    // press, so it is switched off for the length of the press, the way
    // every control floating over the map does it (mapIsolation.ts).
    const map = (layer as unknown as { _map?: L.Map })._map;
    let release: (() => void) | null = null;

    const onPointerDown = (event: PointerEvent) => {
      if (map == null || event.button > 0 || release != null) {
        return;
      }

      event.stopPropagation();
      event.preventDefault();

      const mapWasDraggable = map.dragging.enabled();
      const start = map.mouseEventToLatLng(event);
      const startBounds = layer.getBounds();
      let moved = false;

      map.dragging.disable();
      // The handles would otherwise stay where they were while the box moves
      // under them; they are rebuilt on re-enable below.
      layer.pm.disable();

      const onPointerMove = (move: PointerEvent) => {
        const now = map.mouseEventToLatLng(move);
        const dLat = now.lat - start.lat;
        const dLng = now.lng - start.lng;

        moved = moved || dLat !== 0 || dLng !== 0;
        layer.setBounds(
          L.latLngBounds(
            [startBounds.getSouth() + dLat, startBounds.getWest() + dLng],
            [startBounds.getNorth() + dLat, startBounds.getEast() + dLng],
          ),
        );
      };

      release = () => {
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', release!);
        document.removeEventListener('pointercancel', release!);
        release = null;

        if (mapWasDraggable) {
          map.dragging.enable();
        }

        // Handles back first: a press that never moved leaves the URL as it
        // was, so nothing else would bring them back.
        layer.pm.enable(EDIT_OPTIONS);

        if (moved) {
          commit();
        }
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', release);
      document.addEventListener('pointercancel', release);
    };

    path?.addEventListener('pointerdown', onPointerDown);

    return () => {
      release?.();
      path?.removeEventListener('pointerdown', onPointerDown);
      layer.off('pm:edit', commit);
      layer.pm.disable();

      if (path != null) {
        layer.removeInteractiveTarget(path as unknown as HTMLElement);
        path.classList.remove('leaflet-interactive');
        layer.options.interactive = false;
      }
    };
  }, [editable]);

  const [, , maxLon, maxLat] = area;
  // Stable per area: react-leaflet re-applies `bounds` whenever the prop's
  // identity changes, and a fresh array every render would reset the layer
  // under geoman's handles on every parent re-render.
  const bounds = useMemo(() => toBounds(area), [area]);

  return (
    <>
      <Rectangle
        ref={ref}
        bounds={bounds}
        // Inert at rest: an outline that caught clicks would shadow the pins
        // and the map under it. The edit effect above makes it interactive
        // for as long as the handles are out.
        pathOptions={INERT_AREA_STYLE}
      />
      {editable && (
        <Marker
          position={[maxLat, maxLon]}
          icon={REMOVE_ICON}
          title="Remove this area"
          keyboard={false}
          // Above the corner handles, which geoman re-adds after every drag.
          zIndexOffset={1000}
          eventHandlers={{ click: onRemove }}
        />
      )}
    </>
  );
}

/**
 * The rectangles on the map, and the draw / edit behaviour behind the top-bar
 * buttons. `onChange` absent (the shared viewer) means the rectangles are
 * shown and nothing else.
 */
export function AreaLayer({
  areas,
  mode = null,
  onChange,
  onModeChange,
}: {
  areas: readonly Bbox[];
  mode?: AreaMode;
  onChange?: (next: Bbox[]) => void;
  onModeChange?: (mode: AreaMode) => void;
}) {
  const map = useLeafletMap();
  const areasRef = useRef(areas);
  areasRef.current = areas;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editable = onChange != null;

  // Draw mode: geoman's rectangle tool, left on after each rectangle so a
  // trip is several drags, until the mode is switched off.
  useEffect(() => {
    if (!editable || mode !== 'draw') {
      return;
    }

    map.pm.enableDraw('Rectangle', {
      continueDrawing: true,
      snappable: false,
      pathOptions: AREA_STYLE,
    });

    const handleCreate = (event: L.LeafletEvent) => {
      const layer = (event as unknown as { layer: L.Rectangle }).layer;
      const next = boundsToBbox(layer.getBounds());

      // The URL draws it from here on; geoman's own layer would be a duplicate.
      layer.remove();
      onChangeRef.current?.([...areasRef.current, next]);
    };

    map.on('pm:create', handleCreate);

    return () => {
      map.off('pm:create', handleCreate);
      map.pm.disableDraw();
    };
  }, [editable, map, mode]);

  // Nothing left to edit: drop back out rather than leave a mode on with no rectangles in it.
  useEffect(() => {
    if (mode === 'edit' && areas.length === 0) {
      onModeChange?.(null);
    }
  }, [areas.length, mode, onModeChange]);

  return (
    <>
      {areas.map((area, index) => (
        <AreaRectangle
          key={`${index}:${area.join(',')}`}
          area={area}
          editable={editable && mode === 'edit'}
          onEdit={(next) =>
            onChangeRef.current?.(
              areasRef.current.map((current, position) => (position === index ? next : current)),
            )
          }
          onRemove={() => onChangeRef.current?.(areasRef.current.filter((_, position) => position !== index))}
        />
      ))}
    </>
  );
}
