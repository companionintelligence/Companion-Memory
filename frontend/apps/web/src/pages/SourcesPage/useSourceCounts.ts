import { useEffect, useState } from 'react';

import { useQuery } from '@apollo/client/react';
import { useLocation } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { GET_CONNECTIONS } from '@/components/connect/ConnectedAccountsSection';
import { useImportApi } from '@/pages/ImportPage/useImportApi';

import { useDevices } from './useDevices';

/**
 * `GET /import/runs` caps at 200 and defaults to 50, and returns rows rather
 * than a total — so the count below is "runs on the first page", and asking for
 * the cap is what keeps that honest for any realistic appliance rather than
 * quietly meaning 50.
 */
const RUN_PAGE = 200;

export interface SourceCounts {
  readonly connections: number;
  /** Runs on the first page of {@link RUN_PAGE}; see the note there. */
  readonly imports: number;
  /** Browsers and machines that have registered with this appliance. */
  readonly devices: number;
  /**
   * Nothing has ever fed this appliance — no connection, no import, no device.
   *
   * Deliberately false until both counts have actually come back. A page that
   * renders its first-run state during the first paint and then swaps it for a
   * populated one flashes "you have nothing" at someone who has plenty.
   */
  readonly isFirstRun: boolean;
  readonly loading: boolean;
}

/**
 * How much data is already coming in, for the two path tiles to report.
 *
 * The two halves of the page answer to two different backends — connections
 * are GraphQL, import runs are the REST import API (`GET /import/runs`; the API
 * has no global prefix, and the hook's own `/api` is stripped by the dev
 * proxy) — so the counts are gathered here rather than in either half.
 */
export function useSourceCounts(): SourceCounts {
  const { isFeatureEnabled } = useFeatures();
  const importEnabled = isFeatureEnabled('import.page');

  const api = useImportApi();
  const { data, loading: connectionsLoading } = useQuery(GET_CONNECTIONS);
  const { devices, loading: devicesLoading } = useDevices();

  const [imports, setImports] = useState<number | null>(null);

  // `/sources/:half?` is ONE route, so crossing between paths does not remount
  // this page. Without a reason to re-ask, the count fetched on arrival would
  // outlive the thing it counts: run an import, cross back to the connect path,
  // and the tiles would still be in their "nothing has ever fed this appliance"
  // first-run state. Every crossing is a cheap, well-timed moment to re-ask.
  const { pathname } = useLocation();

  useEffect(() => {
    if (!importEnabled) {
      setImports(0);

      return;
    }

    if (!api.ready) {
      return;
    }

    let cancelled = false;

    void api
      .listRuns(RUN_PAGE)
      .then((runs) => {
        if (!cancelled) {
          setImports(runs.length);
        }
      })
      .catch(() => {
        // An unreachable import API is not evidence that nothing was ever
        // imported, so this stays `null` and `isFirstRun` stays false: the
        // page shows its compact form rather than telling someone with a
        // decade of Takeout that they have nothing.
        if (!cancelled) {
          setImports(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, importEnabled, pathname]);

  const connections = data?.connections.totalCount ?? 0;
  const loading = connectionsLoading || devicesLoading || imports === null;

  return {
    connections,
    imports: imports ?? 0,
    devices: devices.length,
    isFirstRun: !loading && connections === 0 && imports === 0 && devices.length === 0,
    loading,
  };
}
