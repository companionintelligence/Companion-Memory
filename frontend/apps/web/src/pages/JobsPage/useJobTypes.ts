import { useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { readJobsSnapshot, writeJobsSnapshot } from './jobsSnapshots';
import { useJobsAuth } from './useJobsAuth';

export interface JobTypeDescriptor {
  readonly label: string;
  readonly category: string;
  readonly description: string;
  readonly interactive: boolean;
}

export interface JobTypesResponse {
  readonly categories: readonly string[];
  readonly types: Readonly<Record<string, JobTypeDescriptor>>;
}

/**
 * The job taxonomy — every event the appliance can emit, with its label and
 * category.
 *
 * Served rather than duplicated in the frontend so the type filter offers
 * exactly what the backend can classify: an event that gains a listener without
 * gaining a taxonomy entry shows up here as missing, instead of silently looking
 * like everything else. Fetched once; the taxonomy is static for a given build.
 */
const JOB_TYPES_URL = '/api/jobs/types';

export function useJobTypes(): { types: JobTypesResponse | null; loading: boolean } {
  const { ready, headers } = useJobsAuth();

  // Static for a build, so a revisit re-labels the table on the first frame
  // rather than showing raw event names until the taxonomy lands again.
  const [restored] = useState(() => readJobsSnapshot<JobTypesResponse>(JOB_TYPES_URL));
  const [types, setTypes] = useState<JobTypesResponse | null>(restored?.value ?? null);
  const [loading, setLoading] = useState(restored == null);

  useEffect(() => {
    let cancelled = false;

    if (!ready) {
      return;
    }

    fetchJson<JobTypesResponse>(JOB_TYPES_URL, { headers })
      .then((response) => {
        if (response) {
          writeJobsSnapshot(JOB_TYPES_URL, response);
        }

        if (!cancelled) {
          setTypes(response ?? null);
        }
      })
      .catch(() => {
        // A missing taxonomy must not break the table — the filter simply
        // offers nothing rather than the page failing to render. A snapshot
        // from earlier in the session is kept: it cannot have gone stale (the
        // taxonomy is fixed for a build), and dropping it would un-label every
        // row over a refetch the operator never asked for.
        if (!cancelled) {
          setTypes((current) => current ?? null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ready, headers]);

  return { types, loading };
}
