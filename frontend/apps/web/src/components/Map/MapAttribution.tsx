import { cn } from '@ci/shadcn';

import { MAP_IMAGERY_ATTRIBUTION } from './Map';

/**
 * Required basemap credit in document flow, so it never covers map controls.
 *
 * The native Leaflet control is an absolute overlay and can sit on top of
 * playback. This compact footer preserves the same credit without competing
 * with anything interactive.
 */
export function MapAttribution({ className }: { className?: string }) {
  return (
    <div
      data-testid="map-attribution"
      className={cn(
        'shrink-0 border-t border-border/40 bg-card/70 px-1.5 py-0.5 text-center text-[8px] leading-3 text-muted-foreground/70 transition-colors hover:text-muted-foreground device:text-[10px]',
        className,
      )}
    >
      <a
        href="https://leafletjs.com"
        target="_blank"
        rel="noreferrer"
        className="underline-offset-2 hover:underline"
      >
        Leaflet
      </a>{' '}
      | {MAP_IMAGERY_ATTRIBUTION}
    </div>
  );
}
