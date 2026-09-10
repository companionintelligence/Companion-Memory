import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import { MetricForecastService } from '@ci/domains/daily-metrics';
import {
  CalibrationService,
  ForecastHistoryService,
  HbpeService,
  PlaceForecastService,
} from '@ci/domains/predictions';
import { PythonFunctionService } from '@ci/domains/python-functions';
import { UserService } from '@ci/domains/user';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { DueForecastType } from '../types/DueForecastType';
import { ForecastHistoryDayType } from '../types/ForecastHistoryType';
import { ForecastType } from '../types/ForecastType';
import { MetricForecastType } from '../types/MetricForecastType';
import { PlaceForecastItemType } from '../types/PlaceForecastType';
import { PredictionCalibrationType } from '../types/PredictionCalibrationType';
import { WeekForecastType } from '../types/WeekForecastType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ForecastType)
export class ForecastResolver {
  constructor(
    private readonly hbpeService: HbpeService,
    private readonly calibrationService: CalibrationService,
    private readonly forecastHistoryService: ForecastHistoryService,
    private readonly placeForecastService: PlaceForecastService,
    private readonly metricForecastService: MetricForecastService,
    private readonly pythonFunctionService: PythonFunctionService,
    private readonly userService: UserService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ForecastResolver.name);
  }

  @Query(() => ForecastType, { nullable: true, description: 'Fetch the HBPE day-ahead forecast histogram' })
  async forecast(
    @Context() context: RequestContext,
    @Args('horizon', { type: () => String, nullable: true, defaultValue: '24h' }) horizon: string,
  ): Promise<ForecastType | null> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return null;
    }

    try {
      const response = await this.hbpeService.getForecast(toServiceContext(context), horizon);

      return ForecastType.toType(response);
    } catch (err) {
      this.logger.error('Forecast query failed', err instanceof Error ? err : new Error(String(err)));

      return null;
    }
  }

  @Query(() => WeekForecastType, {
    nullable: true,
    description: 'Fetch the HBPE week-horizon occurrence forecast (per-day cluster probabilities)',
  })
  async weekForecast(
    @Context() context: RequestContext,
    @Args('includeToday', { type: () => Boolean, nullable: true, defaultValue: false })
    includeToday: boolean,
  ): Promise<WeekForecastType | null> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return null;
    }

    try {
      const serviceContext = toServiceContext(context);
      const user = await this.userService.findById(serviceContext, serviceContext.userId);
      const timezone = user?.timezone ?? 'UTC';

      const response = await this.hbpeService.getWeekForecast(serviceContext, includeToday, timezone);

      return WeekForecastType.toType(response);
    } catch (err) {
      this.logger.error('Week forecast query failed', err instanceof Error ? err : new Error(String(err)));

      return null;
    }
  }

  @Query(() => DueForecastType, {
    nullable: true,
    description: 'Fetch HBPE renewal predictions: periodic behaviors coming due or overdue',
  })
  async dueForecast(@Context() context: RequestContext): Promise<DueForecastType | null> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return null;
    }

    try {
      const response = await this.hbpeService.getDueList(toServiceContext(context));

      return DueForecastType.toType(response);
    } catch (err) {
      this.logger.error('Due forecast query failed', err instanceof Error ? err : new Error(String(err)));

      return null;
    }
  }

  @Query(() => [MetricForecastType], {
    description: '1–7 day seasonal-naive + EWMA forecast of daily-metrics scalars',
  })
  async metricForecast(
    @Context() context: RequestContext,
    @Args('days', { type: () => Int, nullable: true, defaultValue: 3 }) days: number,
  ): Promise<MetricForecastType[]> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return [];
    }

    try {
      const serviceContext = toServiceContext(context);
      const user = await this.userService.findById(serviceContext, serviceContext.userId);
      const rows = await this.metricForecastService.forecastAll(
        serviceContext,
        days,
        user?.timezone ?? 'UTC',
      );

      return rows.map(MetricForecastType.toType);
    } catch (err) {
      this.logger.error('Metric forecast query failed', err instanceof Error ? err : new Error(String(err)));

      return [];
    }
  }

  @Query(() => [ForecastHistoryDayType], {
    description: 'Past forecast-vs-actual buckets from hbpe.prediction_log',
  })
  async forecastHistory(
    @Context() context: RequestContext,
    @Args('days', { type: () => Int, nullable: true, defaultValue: 5 }) days: number,
  ): Promise<ForecastHistoryDayType[]> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return [];
    }

    try {
      const history = await this.forecastHistoryService.getRecentDays(toServiceContext(context), days);

      return history.map(ForecastHistoryDayType.toType);
    } catch (err) {
      this.logger.error('Forecast history query failed', err instanceof Error ? err : new Error(String(err)));

      return [];
    }
  }

  @Query(() => [PlaceForecastItemType], {
    description:
      'Likely next places from the stay-point transition model (recency-decayed, hour/dow backoff)',
  })
  async placeForecast(
    @Context() context: RequestContext,
    @Args('k', { type: () => Int, nullable: true, defaultValue: 5 }) k: number,
    @Args('horizonHours', { type: () => Int, nullable: true, defaultValue: 4 }) horizonHours: number,
  ): Promise<PlaceForecastItemType[]> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return [];
    }

    try {
      const places = await this.placeForecastService.predictNext(toServiceContext(context), k, horizonHours);

      return places.map(PlaceForecastItemType.toType);
    } catch (err) {
      this.logger.error('Place forecast query failed', err instanceof Error ? err : new Error(String(err)));

      return [];
    }
  }

  @Query(() => PredictionCalibrationType, {
    nullable: true,
    description: 'Forecast self-consistency scores (not ground-truth accuracy)',
  })
  async predictionCalibration(
    @Context() context: RequestContext,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 14 }) limit: number,
  ): Promise<PredictionCalibrationType | null> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return null;
    }

    try {
      const report = await this.calibrationService.getReport(toServiceContext(context), limit);

      return PredictionCalibrationType.toType(report);
    } catch (err) {
      this.logger.error('Calibration query failed', err instanceof Error ? err : new Error(String(err)));

      return null;
    }
  }

  @Mutation(() => String, {
    description: 'Rebuild stay-point clusters and recency-decayed transitions for the current user',
  })
  // PlaceTransitionService.rebuild issues an unconditional whole-user DELETE before re-inserting.
  // Derived and recomputable in principle — but if clustering yields nothing the delete still
  // happened and the table is left empty.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async rebuildPlaces(@Context() context: RequestContext): Promise<string> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return 'disabled';
    }

    try {
      const serviceContext = toServiceContext(context);
      const user = await this.userService.findById(serviceContext, serviceContext.userId);
      const result = await this.placeForecastService.rebuild(serviceContext, user?.timezone ?? 'UTC');

      return `${result.clusters} clusters, ${result.transitions} transitions`;
    } catch (err) {
      this.logger.error('Place rebuild failed', err instanceof Error ? err : new Error(String(err)));

      return 'error';
    }
  }

  @Mutation(() => String, { description: 'Manually trigger the HBPE pipeline for the current user' })
  async triggerHbpe(@Context() context: RequestContext): Promise<string> {
    if (!(await this.featureService.isFeatureEnabled('hbpe'))) {
      return 'disabled';
    }

    if (!context.userId) {
      return 'error';
    }

    try {
      // The nightly pipeline covers cold start too: its bootstrap check trains
      // the model when the checkpoint is missing or stale. Routed through
      // pg-boss so the run gets retries and shows up in the jobs monitor.
      const enqueued = await this.pythonFunctionService.dispatch(
        'hbpe',
        'nightly',
        context.userId,
        {},
        {
          singletonKey: `fn:nightly:${context.userId}:manual`,
        },
      );

      return enqueued ? 'triggered' : 'already_running';
    } catch (err) {
      this.logger.error('HBPE trigger dispatch failed', err instanceof Error ? err : new Error(String(err)));

      return 'error';
    }
  }
}
