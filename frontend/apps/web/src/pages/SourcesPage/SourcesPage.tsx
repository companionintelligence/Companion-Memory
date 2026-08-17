import { usePageTitle } from '@ci/common';
import { Navigate, useParams } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { PageContent } from '@/components/layout';
import { ImportSurface } from '@/pages/ImportPage/ImportPage';

import { ConnectPanel } from './ConnectPanel';
import { DevicesPanel } from './DevicesPanel';
import { PathHeader } from './PathHeader';
import { SOURCE_PATHS, SourcePathTiles, type SourcePath } from './SourcePathTiles';
import { useSourceCounts } from './useSourceCounts';

/**
 * Where your memory comes from — one page, two paths.
 *
 * This is the merge of three routes that answered one question. `/connections`
 * was a status list behind the account dropdown whose empty state read
 * `Total Connections: 0`; `/connect` was the gallery of what you could add;
 * `/import` was the archive wizard, reachable through a single card on
 * `/connect`. The user has one intention — get my stuff in — with exactly two
 * answers, so it is one page with two halves and one switch that is always on
 * screen.
 *
 * See `docs/design/sources-ia.md` for the full reasoning, including why the two
 * halves keep addressable URLs and why the empty state is the switch rather
 * than a screen of its own.
 */
export function SourcesPage() {
  const { isFeatureEnabled } = useFeatures();
  const importEnabled = isFeatureEnabled('import.page');
  const counts = useSourceCounts();

  // One route with a `:half` param rather than sibling routes, so the switch
  // and the counts mount once and survive the crossing — no page-level
  // remount, no refetch, when someone moves between paths.
  const { half } = useParams<{ half?: string }>();

  // Only the import path is gated. A gated ROUTE in this app is never
  // registered rather than blocked, which is why /sources itself is not one:
  // the other three paths must exist whatever `import.page` says.
  const paths = SOURCE_PATHS.filter((path) => path !== 'import' || importEnabled);

  usePageTitle('Sources - Companion Intelligence');

  // A path that does not exist gets normalised rather than 404'd: /sources
  // itself, a typo, and — the case that matters — /sources/import on an
  // appliance with importing turned off, which must land somewhere real
  // instead of on a surface that is not registered.
  if (!paths.includes(half as SourcePath)) {
    return <Navigate to="/sources/connect" replace />;
  }

  const active = half as SourcePath;

  return (
    <>
      {/* Just the page name. The trail used to read "Companion › Sources ›
          Connect": "Companion" is the whole app and leads to Feed, and the last
          crumb repeated the tile already highlighted on screen. Two steps of a
          three-step path that nobody navigates by. */}

      <PageContent>
        {/* No page heading or standfirst: the breadcrumb above already reads
            "Sources", the rail entry says Sources, and the tiles below say what
            each path is for. A title and a paragraph restating all three pushed
            the only actionable thing on the screen below the fold.

            The switch stays put; only the active path scrolls, in its own
            region. The import path needs that anyway — its wizard pins a step
            row and a Continue button and scrolls the service list between them,
            which needs a real ceiling to scroll against. */}
        <div className="flex min-h-0 flex-1 flex-col gap-6">
          <SourcePathTiles active={active} counts={counts} paths={paths} />

          {/* Import keeps its own scroll shape — the wizard pins a step row and
              a Continue button and scrolls the list between them — so its header
              sits outside that region rather than inside the scroller. */}
          {active === 'import' ? (
            <>
              <PathHeader path="import" />
              <ImportSurface />
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {active === 'connect' && <ConnectPanel />}
              {active === 'devices' && <DevicesPanel />}
            </div>
          )}
        </div>
      </PageContent>
    </>
  );
}

export default SourcesPage;
