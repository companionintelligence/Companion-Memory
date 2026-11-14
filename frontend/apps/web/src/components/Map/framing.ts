import type { LatLngExpression, Map as LeafletMap } from 'leaflet';

/** Room, in px, that framing leaves between the pins and the edge of the map. */
export const FIT_PADDING_PX = 60;

/**
 * Padding for Leaflet's `fitBounds` that frames pins in the part of the map
 * you can see: `edge` px all round, plus `panelInset` on the left for a panel
 * lying over the map's left edge (the desktop timeline). Even `padding` framed
 * pins against the map's full width and put some of them under the panel.
 */
export function fitPadding(
  panelInset = 0,
  edge = FIT_PADDING_PX,
): {
  paddingTopLeft: [number, number];
  paddingBottomRight: [number, number];
} {
  return {
    paddingTopLeft: [edge + panelInset, edge],
    paddingBottomRight: [edge, edge],
  };
}

/**
 * The map centre, at `zoom`, that puts `latLng` in the middle of what a panel
 * `panelInset` px wide over the map's left edge leaves uncovered. Centring on
 * `latLng` itself puts it in the middle of the whole map, which on a narrow
 * desktop window is the panel's right edge.
 */
export function centerBesidePanel(
  map: Pick<LeafletMap, 'project' | 'unproject'>,
  latLng: LatLngExpression,
  zoom: number,
  panelInset = 0,
): LatLngExpression {
  if (panelInset <= 0) {
    return latLng;
  }

  return map.unproject(map.project(latLng, zoom).subtract([panelInset / 2, 0]), zoom);
}
