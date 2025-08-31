import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ConversationModule } from '@ci/domains/conversations';
import { EventsModule } from '@ci/domains/events';
import { FilesModule } from '@ci/domains/files';

import { OllamaController } from './controllers/OllamaController';
import { OllamaService } from './services/OllamaService';
import {
  GetUserPreferencesTool,
  GetEntertainmentPreferencesTool,
  GetStreamingAvailabilityTool,
} from './tools';
import { ToolRegistry } from './tools/ToolRegistry';

@Module({
  imports: [ConversationModule, EventsModule, FilesModule],
  providers: [
    {
      provide: ToolRegistry,
      useFactory: (dataSource: DataSource) => {
        const toolRegistry = new ToolRegistry();

        // Initialize tools
        const getUserPreferencesTool = new GetUserPreferencesTool(dataSource);
        const getEntertainmentPreferencesTool = new GetEntertainmentPreferencesTool(dataSource);
        const getStreamingAvailabilityTool = new GetStreamingAvailabilityTool();

        toolRegistry.register(getUserPreferencesTool);
        toolRegistry.register(getEntertainmentPreferencesTool);
        toolRegistry.register(getStreamingAvailabilityTool);

        return toolRegistry;
      },
      inject: [DataSource],
    },
    OllamaService,
  ],
  controllers: [OllamaController],
  exports: [OllamaService, ToolRegistry],
})
export class LLMModule {}

// Entities
export {};

// Services
export { OllamaService };
export { ToolRegistry } from './tools/ToolRegistry';

// Types
export type {} from './types';
