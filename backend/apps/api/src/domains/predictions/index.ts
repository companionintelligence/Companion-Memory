import { Module } from '@nestjs/common';

import { LoggingModule } from '@ci/common/logging';
import { DailyMetricsModule } from '@ci/domains/daily-metrics';
import { UserModule } from '@ci/domains/user';

import { CalibrationService } from './services/CalibrationService';
import { ForecastHistoryService } from './services/ForecastHistoryService';
import { HbpeService } from './services/HbpeService';
import { PlaceForecastService } from './services/PlaceForecastService';

@Module({
  imports: [LoggingModule, DailyMetricsModule, UserModule],
  providers: [HbpeService, CalibrationService, ForecastHistoryService, PlaceForecastService],
  exports: [HbpeService, CalibrationService, ForecastHistoryService, PlaceForecastService],
})
export class PredictionsModule {}

export { HbpeService, CalibrationService, ForecastHistoryService, PlaceForecastService };
export { CALIBRATION_BASIS } from './services/CalibrationService';
export type { CalibrationReport, CalibrationScore } from './services/CalibrationService';
export type { PlaceForecastItem } from './services/PlaceForecastService';
export type { ForecastHistoryBucket, ForecastHistoryDay } from './services/ForecastHistoryService';
export type {
  DueItem,
  DueResponse,
  ForecastBucket,
  ForecastResponse,
  ForageTrialResponse,
  WeekForecastCluster,
  WeekForecastDay,
  WeekForecastResponse,
} from './types';
