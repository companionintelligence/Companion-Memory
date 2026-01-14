import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { SummaryEntity } from './entities/SummaryEntity';
import { SummaryService } from './services/SummaryService';

@Module({
  imports: [TypeOrmModule.forFeature([SummaryEntity]), EventsModule],
  providers: [SummaryService],
  exports: [SummaryService],
})
export class SummariesModule {}

export { SummaryEntity };
export { SummaryService };
export type { Summary } from './entities/SummaryEntity';
export type { CreateSummaryDto, UpdateSummaryDto } from './types';
