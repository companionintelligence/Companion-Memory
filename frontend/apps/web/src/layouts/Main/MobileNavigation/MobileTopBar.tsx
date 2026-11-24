import { useLocation } from 'react-router-dom';

import { ConnectionModeIndicator, OutboxQueueIndicator } from '@/components/ConnectionModeIndicator';
import { GlobalSearchBox } from '@/components/SearchBox';

import { AddMenu } from '../AddMenu';
import { usePowerRail } from '../PowerRailContext';
import { RailEdgeToggle } from '../RailEdgeToggle';

import { EntityBackBar } from './EntityBackBar';

/**
 * Phone header: chevron, search, chips, and Add in one row, in the layout
 * flow so page content starts below it instead of under it.
 */
function PhoneHeader() {
  const { expanded, toggle } = usePowerRail();
  const { pathname } = useLocation();
  const isSharedView = pathname.startsWith('/shared/');

  return (
    <header className="z-20 flex shrink-0 items-center gap-2 px-2 pb-1.5 pt-2">
      <RailEdgeToggle open={expanded} onClick={toggle} />
      {!isSharedView && (
        <div className="min-w-0 flex-1">
          <GlobalSearchBox />
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        <ConnectionModeIndicator />
        <OutboxQueueIndicator />
      </div>
      <AddMenu />
    </header>
  );
}

/**
 * The phone header, and under it — on an entity's full page only — a Back row,
 * because the phone has no other way back (see {@link EntityBackBar}).
 */
export function MobileTopBar() {
  return (
    <>
      <PhoneHeader />
      <EntityBackBar />
    </>
  );
}
