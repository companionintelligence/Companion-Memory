import { Module } from '@nestjs/common';

import { LoggingModule } from '@ci/common/logging';

import { HbpeService } from './services/HbpeService';

@Module({
  imports: [LoggingModule],
  providers: [HbpeService],
  exports: [HbpeService],
})
export class PredictionsModule {}

export { HbpeService };
export type { ForecastBucket, ForecastResponse } from './types';
