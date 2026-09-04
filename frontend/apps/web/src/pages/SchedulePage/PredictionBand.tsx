import { Button } from '@ci/shadcn';
import { RotateCw } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import type { ForecastResponse } from '@/api/useForecastService';
import { ForecastStrip } from '@/components/ForecastStrip';

export interface PredictionBandProps {
  forecast: ForecastResponse | null;
  loading: boolean;
  stalled: boolean;
  showFullForecastLink: boolean;
  /**
   * Re-issues the forecast query.
   *
   * Nothing else will. `ForecastResolver.ts` swallows an HBPE failure and
   * answers `null`, and `useForecastService`'s effect reads a null forecast as
   * "nothing to poll for" and calls `stopPolling()` — so the unavailable state
   * is terminal until the user navigates away and back. Telling them to "try
   * again shortly" over a request that will never be made again is the failure
   * this prop exists to end.
   */
  onRetry: () => void;
}

/**
 * Calendar's compact, inspectable view of the day-ahead HBPE histogram.
 *
 * The forecast object crosses this boundary intact. `ForecastStrip` owns the
 * display-only local-clock ordering and exposes every L0/L1 probability on
 * hover; this component only supplies context and honest request states.
 */
export function PredictionBand({
  forecast,
  loading,
  stalled,
  showFullForecastLink,
  onRetry,
}: PredictionBandProps) {
  return (
    <section
      aria-labelledby="prediction-band-heading"
      className="rounded-lg border border-border bg-card/40 p-3 md:p-4"
      data-testid="prediction-band"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="prediction-band-heading" className="text-base font-semibold text-foreground">
            Tomorrow&apos;s prediction band
          </h2>
          <p className="text-xs text-muted-foreground">
            96 quarter-hour bins directly from HBPE. Hover a bin to inspect its probabilities.
          </p>
        </div>

        {showFullForecastLink && (
          <Button asChild variant="ghost" size="sm" className="h-8 text-xs">
            <Link to="/forecast">Open full forecast</Link>
          </Button>
        )}
      </div>

      {forecast ? (
        <ForecastStrip
          buckets={forecast.buckets}
          generatedAt={forecast.generatedAt}
          systemStatus={forecast.systemStatus}
          stalled={stalled}
          stillLearning={forecast.stillLearning}
          modelVersion={forecast.modelVersion}
          pipelineEtaSeconds={forecast.pipelineEtaSeconds}
          pipelineDetail={forecast.pipelineDetail}
          className="mt-3"
        />
      ) : loading ? (
        // Two separate nodes, each with its own key, rather than one paragraph
        // whose `role` flips between renders: a live region that changes role
        // in place asks a screen reader to reinterpret a region it is already
        // watching, and announcement of the swap is left to the AT. Remounting
        // retires the polite region and introduces the assertive one.
        <p key="prediction-band-loading" role="status" className="mt-3 text-sm text-muted-foreground">
          Loading the prediction band…
        </p>
      ) : (
        <div
          key="prediction-band-unavailable"
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        >
          {/* Same reading as ForecastPage's empty state — the resolver's
              try/catch means a null forecast is always a failed call, never an
              untrained model (that answers with systemStatus: 'COLD_START'). */}
          <span>Couldn&apos;t reach HBPE for the prediction band.</span>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onRetry}>
            <RotateCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
