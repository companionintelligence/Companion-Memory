import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConversationModule } from '@ci/domains/conversations';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { UserModule } from '@ci/domains/user';

import { ActivityRollupCron } from './cron/ActivityRollupCron';
import { ActivityRollupEntity } from './entities/ActivityRollupEntity';
import { ActivityRollupService } from './services/ActivityRollupService';

@Module({
  imports: [
    TypeOrmModule.forFeature([ActivityRollupEntity]),
    ConversationModule,
    FilesModule,
    IntelligenceModule,
    MemoryModule,
    NotesModule,
    UserModule,
  ],
  providers: [ActivityRollupService, ActivityRollupCron],
  exports: [ActivityRollupService],
})
export class ActivityModule {}

// Entities
export { ActivityRollupEntity };

// Services
export { ActivityRollupService };
export type {
  ActivityBucketRow,
  ActivityDailyCount,
  ActivityDailyCountsParams,
} from './services/ActivityRollupService';
