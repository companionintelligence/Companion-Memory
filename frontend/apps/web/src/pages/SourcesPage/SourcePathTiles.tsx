import type { ReactNode } from 'react';

import { cn } from '@ci/shadcn';
import { ArrowRight } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { SOURCES_SECTIONS, type SourcePath } from './sourcesSections';
import type { SourceCounts } from './useSourceCounts';

export type { SourcePath };

export const SOURCE_PATHS: readonly SourcePath[] = SOURCES_SECTIONS.map((section) => section.path);

export interface PathDefinition {
  readonly path: SourcePath;
  readonly to: string;
  readonly icon: ReactNode;
  readonly title: string;
  /** The honest trade-off, rendered by `PathHeader` above the path's content. */
  readonly effort: string;
  readonly gets: string;
  readonly cta: string;
}

/**
 * What each path is, what it costs, and what it gives you.
 *
 * The `effort`/`gets` pair is rendered by {@link PathHeader} at the top of the
 * path's own content, not on the tile. On the tile it made three tiles three
 * different heights and pushed the content below the fold; in the content it
 * is the answer to "what am I looking at" in the one place someone is already
 * looking, and every path reads the same way.
 */
/**
 * The pitch for each path. Route, label and icon are NOT restated here — they
 * come from {@link SOURCES_SECTIONS}, which the Power Rail's Sources submenu
 * reads from the same module. Two copies of a route is how a rail row and the
 * tile it duplicates end up pointing at different places.
 */
const PATH_PITCH: Record<SourcePath, Pick<PathDefinition, 'effort' | 'gets' | 'cta'>> = {
  connect: {
    effort: 'About a minute, once.',
    gets: 'Everything from now on, plus whatever recent history the service hands over.',
    cta: 'Browse services',
  },
  import: {
    effort: 'You request it from the service and wait hours or days, then it takes minutes.',
    gets: 'Your whole history, as far back as the service keeps it.',
    cta: 'Start an import',
  },
  devices: {
    effort: 'Install once, on each browser and machine you use.',
    gets: 'What you read, and what you do on your own computer — neither of which any export contains.',
    cta: 'Add a device',
  },
};

export const SOURCE_PATH_INFO: Record<SourcePath, PathDefinition> = Object.fromEntries(
  SOURCES_SECTIONS.map((section) => {
    const Icon = section.icon;

    return [
      section.path,
      {
        path: section.path,
        to: section.to,
        icon: <Icon aria-hidden className="h-7 w-7" strokeWidth={1.25} />,
        title: section.label,
        ...PATH_PITCH[section.path],
      },
    ];
  }),
) as Record<SourcePath, PathDefinition>;

interface Props {
  /** Which path is on screen, so the switch can say so. */
  active: SourcePath;
  counts: SourceCounts;
  /** The paths this appliance actually offers, in order. */
  paths: readonly SourcePath[];
}

/** What this path has to show for itself, as its tile reports it. */
function countFor(path: SourcePath, counts: SourceCounts): { value: number; noun: string } {
  switch (path) {
    case 'connect':
      return { value: counts.connections, noun: 'connected' };
    case 'import':
      return { value: counts.imports, noun: counts.imports === 1 ? 'import' : 'imports' };
    case 'devices':
      return { value: counts.devices, noun: counts.devices === 1 ? 'device' : 'devices' };
  }
}

/**
 * The ways data gets in, as one control.
 *
 * Three tiles of one shape: an icon, a name, and what you have of it. They used
 * to carry the pitch as well — `Effort` and `You get` — which made each tile as
 * tall as its longest sentence, gave the row three different heights, and
 * pushed the actual content below the fold. The pitch belongs where you are
 * already looking once you pick a path, so it moved into the path's own header
 * and the switch went back to being a switch.
 */
export function SourcePathTiles({ active, counts, paths }: Props) {
  return (
    <section aria-label="Ways to add data" className="w-full">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {paths.map((key) => {
          const count = countFor(key, counts);

          return (
            <PathTile key={key} definition={SOURCE_PATH_INFO[key]} active={active === key} count={count} />
          );
        })}
      </div>
    </section>
  );
}

interface PathTileProps {
  definition: PathDefinition;
  active: boolean;
  count: { value: number; noun: string };
}

function PathTile({ definition, active, count }: PathTileProps) {
  return (
    <Link
      to={definition.to}
      // `page` and not `true`: the tile IS the page you are on, and a screen
      // reader saying "current page" is the same thing the ring says visually.
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition',
        'hover:border-primary/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-primary ring-1 ring-primary/40' : 'border-border',
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md p-2',
          active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {definition.icon}
      </span>

      <span className="min-w-0 flex-1 font-semibold">{definition.title}</span>

      {count.value > 0 ? (
        <span className="text-muted-foreground shrink-0 text-xs font-medium tabular-nums">
          {count.value} {count.noun}
        </span>
      ) : (
        <ArrowRight
          aria-hidden
          className="text-muted-foreground h-4 w-4 shrink-0 transition group-hover:translate-x-0.5"
        />
      )}
    </Link>
  );
}
