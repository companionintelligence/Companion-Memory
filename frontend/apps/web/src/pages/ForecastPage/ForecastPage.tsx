import { EmptyState, ErrorPage, LoadingPage, usePageTitle } from '@ci/common';
import { CloudSun } from '@ci/shadcn/icons';

import { useForecastService, useWeekAheadService } from '@/api';
import { useFeatures } from '@/common/feature';
import { ForecastStrip } from '@/components/ForecastStrip';
import { PageContent } from '@/components/layout';
import { WeekAhead } from '@/components/WeekAhead';
import { placeVisible } from '@/lib/forecastDisplay';

import { NextForecast } from './BranchialTree';
import { NextPlacesPanel } from './ForecastPanels';
import { OffScript } from './OffScript';
import { useForecastExtras } from './useForecastExtras';

export function ForecastPage() {
  usePageTitle('Forecast - Companion Intelligence');

  const { isFeatureEnabled } = useFeatures();
  const hbpeEnabled = isFeatureEnabled('hbpe');
  const [{ data: forecast, loading, error, stalled }] = useForecastService();
  const extras = useForecastExtras();
  const { week, due } = useWeekAheadService();
  const places = extras.places.filter(placeVisible);

  return (
    <>
      <PageContent className="md:pt-[max(0.75rem,env(safe-area-inset-top))]">
        {!hbpeEnabled ? (
          <div className="relative min-h-60 flex-1">
            <EmptyState icon={<CloudSun size={48} />} message="Forecast is off for this workspace." />
          </div>
        ) : loading && !forecast ? (
          <LoadingPage />
        ) : error && !forecast ? (
          <ErrorPage error={error} />
        ) : !forecast ? (
          // Reached only once hbpeEnabled is true and no error was thrown — the
          // resolver's try/catch (ForecastResolver.ts) swallows a real HBPE
          // failure and returns null either way. A genuinely untrained model
          // does not land here: it returns real data with
          // systemStatus: 'COLD_START' instead of a null forecast. So this is
          // always a failed/unreachable call, never "not started yet" — the
          // copy has to say that rather than point at Add → Predict.
          <div className="relative min-h-60 flex-1">
            <EmptyState
              icon={<CloudSun size={48} />}
              message="Couldn't reach the forecasting service just now. Try again shortly."
            />
          </div>
        ) : (
          <div className="flex flex-col gap-6" data-testid="tomorrows-forecast">
            <div>
              <h2 className="text-2xl font-bold text-foreground">Tomorrow&apos;s Forecast</h2>
              <ForecastStrip
                buckets={forecast.buckets}
                generatedAt={forecast.generatedAt}
                systemStatus={forecast.systemStatus}
                stalled={stalled}
                stillLearning={forecast.stillLearning}
                modelVersion={forecast.modelVersion}
                pipelineEtaSeconds={forecast.pipelineEtaSeconds}
                pipelineDetail={forecast.pipelineDetail}
              />
            </div>
            <NextForecast />
            <OffScript
              historyDays={extras.historyDays}
              drift={Boolean(extras.calibration?.latest?.driftFlag)}
            />
            <WeekAhead week={week} due={due} />
            {places.length > 0 ? <NextPlacesPanel places={places} /> : null}
          </div>
        )}
      </PageContent>
    </>
  );
}
