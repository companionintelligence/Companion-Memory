import { type ComponentType, useEffect, useMemo, useRef } from 'react';

import { cn } from '@ci/shadcn';
import { Squircle } from '@ci/shadcn/icons';
import L, { type LeafletMouseEvent } from 'leaflet';
import { renderToString } from 'react-dom/server';
import { Marker as LeafletMarker, type MarkerProps } from 'react-leaflet';

import { ENTITY_VISUALS, type EntityKind } from '@/components/entities/entityVisuals';

const MARKER_DIAMETER = 48; // Corresponds to h-12, w-12
const POINTER_HEIGHT = 38; // The height of the CSS triangle
const LONG_PRESS_MS = 500;

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
  onContextMenu?: (e: LeafletMouseEvent) => void;
  onMouseEnter?: (e: LeafletMouseEvent) => void;
  onMouseLeave?: (e: LeafletMouseEvent) => void;
}

export function Marker({
  variant = 'default',
  onClick,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  ...markerProps
}: Props) {
  const icon = useMemo(() => makeMarkerIcon(variant), [variant]);
  const pressTimerRef = useRef<number | null>(null);
  const pressFiredRef = useRef(false);

  useEffect(() => {
    return () => {
      if (pressTimerRef.current != null) {
        window.clearTimeout(pressTimerRef.current);
      }
    };
  }, []);

  const eventHandlers = useMemo(() => {
    const clearPress = () => {
      if (pressTimerRef.current != null) {
        window.clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
    };

    const isCoarsePointer = (e: LeafletMouseEvent) => {
      const orig = e.originalEvent as PointerEvent | TouchEvent | MouseEvent;
      if ('pointerType' in orig && orig.pointerType === 'touch') {
        return true;
      }

      return window.matchMedia?.('(pointer: coarse)').matches ?? false;
    };

    return {
      click: (e: LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        if (pressFiredRef.current) {
          pressFiredRef.current = false;
          L.DomEvent.preventDefault(e.originalEvent);

          return;
        }

        onClick?.(e);
      },
      mousedown: (e: LeafletMouseEvent) => {
        pressFiredRef.current = false;
        if (!onContextMenu || !isCoarsePointer(e)) {
          return;
        }

        clearPress();
        pressTimerRef.current = window.setTimeout(() => {
          pressTimerRef.current = null;
          pressFiredRef.current = true;
          onContextMenu(e);
        }, LONG_PRESS_MS);
      },
      mouseup: () => {
        clearPress();
      },
      contextmenu: (e: LeafletMouseEvent) => {
        clearPress();
        L.DomEvent.stopPropagation(e);
        e.originalEvent.preventDefault();
        onContextMenu?.(e);
      },
      dblclick: (e: LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
      },
      mouseover: (e: LeafletMouseEvent) => {
        onMouseEnter?.(e);
      },
      mouseout: (e: LeafletMouseEvent) => {
        clearPress();
        onMouseLeave?.(e);
      },
    };
  }, [onClick, onContextMenu, onMouseEnter, onMouseLeave]);

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
