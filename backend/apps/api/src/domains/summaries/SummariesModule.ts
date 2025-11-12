import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { SummarySchedulerService } from './services/SummarySchedulerService';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity]), EventsModule],
  providers: [SummarySchedulerService],
})
export class SummariesModule {}
