import { type ComponentType, useMemo } from 'react';

import { cn } from '@ci/shadcn';
import { Squircle } from '@ci/shadcn/icons';
import L, { type LeafletMouseEvent } from 'leaflet';
import { renderToString } from 'react-dom/server';
import { Marker as LeafletMarker, type MarkerProps } from 'react-leaflet';

import { ENTITY_VISUALS, type EntityKind } from '@/components/entities/entityVisuals';

const MARKER_DIAMETER = 48; // Corresponds to h-12, w-12
const POINTER_HEIGHT = 38; // The height of the CSS triangle

// Entity-kind variants colour/icon-code each point by what it represents
// (sourced from the shared entityVisuals palette so the map matches the list,
// gallery and graph). The plain colour names are kept for back-compat with
// existing callers / stories.
export type MarkerVariant = EntityKind | 'default' | 'blue' | 'red' | 'green';

type MarkerStyle = { Icon: ComponentType<{ className?: string }> };

const BASIC_STYLES: Record<'default' | 'blue' | 'red' | 'green', MarkerStyle> = {
  default: { Icon: Squircle },
  blue: { Icon: Squircle },
  red: { Icon: Squircle },
  green: { Icon: Squircle },
};

function styleFor(variant: MarkerVariant): MarkerStyle {
  if (variant in BASIC_STYLES) {
    return BASIC_STYLES[variant as keyof typeof BASIC_STYLES];
  }

  const visual = ENTITY_VISUALS[variant as EntityKind];

  return visual ? { Icon: visual.Icon } : BASIC_STYLES.default;
}

interface Props extends Omit<MarkerProps, 'icon'> {
  variant?: MarkerVariant;
  onClick?: (e: LeafletMouseEvent) => void;
  onMouseEnter?: (e: LeafletMouseEvent) => void;
  onMouseLeave?: (e: LeafletMouseEvent) => void;
}

export function Marker({ variant = 'default', onClick, onMouseEnter, onMouseLeave, ...markerProps }: Props) {
  const icon = useMemo(() => makeMarkerIcon(variant), [variant]);

  const eventHandlers = useMemo(
    () => ({
      click: (e: LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        onClick?.(e);
      },
      dblclick: (e: LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
      },
      mouseover: (e: LeafletMouseEvent) => {
        onMouseEnter?.(e);
      },
      mouseout: (e: LeafletMouseEvent) => {
        onMouseLeave?.(e);
      },
    }),
    [onClick, onMouseEnter, onMouseLeave],
  );

  return <LeafletMarker zIndexOffset={400} {...markerProps} icon={icon} eventHandlers={eventHandlers} />;
}

function makeMarkerIcon(variant: MarkerVariant): L.DivIcon {
  const { Icon } = styleFor(variant);
  const markerColor = 'var(--primary)';

  const html = renderToString(
    <div className="relative flex flex-col items-center">
      <div
        // Tokenized pin colors keep the map in sync with light/dark themes while
        // the glyph continues to communicate entity type.
        className="custom-map-marker-pin h-12 w-12 p-1 relative flex items-center justify-center rounded-full border-4 border-background shadow-md"
        style={{ backgroundColor: markerColor }}
      >
        <Icon className="text-[var(--primary-foreground)]" />
      </div>

      <div
        className={cn('w-0 h-0', 'border-l-transparent border-r-transparent')}
        style={{
          // These are styles because Tailwind doesn't support dynamic values for border widths
          // and does not generate the required classes since we're using calculated values.
          borderTopColor: markerColor,
          borderLeftWidth: `${MARKER_DIAMETER / 2}px`,
          borderRightWidth: `${MARKER_DIAMETER / 2}px`,
          borderTopWidth: `${POINTER_HEIGHT}px`,
          marginTop: `-${MARKER_DIAMETER / 2}px`,
        }}
      />
    </div>,
  );

  const totalHeight = MARKER_DIAMETER / 2 + POINTER_HEIGHT;

  return L.divIcon({
    className: 'custom-map-marker', // This class should have no default Leaflet background/border
    html,
    iconSize: [MARKER_DIAMETER, totalHeight],
    iconAnchor: [MARKER_DIAMETER / 2, totalHeight],
    popupAnchor: [0, -totalHeight],
  });
}
