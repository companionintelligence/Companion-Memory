import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConversationModule } from '@ci/domains/conversations';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { SearchNextModule } from '@ci/domains/search-next';
import { SummariesModule } from '@ci/domains/summaries';
import { UserEntity } from '@ci/domains/user';

import { AgentController } from './controllers/AgentController';
import { AgentServiceAuthGuard } from './guards/AgentServiceAuthGuard';
import { AgentOwnerService } from './services/AgentOwnerService';
import { AgentReadService } from './services/AgentReadService';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity]),
    BrowserActivityModule,
    ConversationModule,
    FilesModule,
    IntelligenceModule,
    MemoryModule,
    NotesModule,
    SearchNextModule,
    SummariesModule,
  ],
  controllers: [AgentController],
  providers: [AgentOwnerService, AgentReadService, AgentServiceAuthGuard],
  exports: [AgentOwnerService, AgentReadService],
})
export class AgentModule {}

export { AgentOwnerService, AgentReadService };
