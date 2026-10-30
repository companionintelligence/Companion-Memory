import { Global, Module } from '@nestjs/common';

import { LoggingModule } from '@ci/common/logging';

import { LiveChangesController } from './controllers/LiveChangesController';
import { LiveChangesService } from './services/LiveChangesService';

/**
 * Global for the same reason `HbpeNotifyModule` is: the publishers are the
 * services that write tasks and calendar events, which sit in modules that
 * must not grow an import just to say "changed". They inject the service
 * `@Optional()`, so a suite that builds them by hand needs nothing.
 */
@Global()
@Module({
  imports: [LoggingModule],
  controllers: [LiveChangesController],
  providers: [LiveChangesService],
  exports: [LiveChangesService],
})
export class LiveChangesModule {}

export {
  LIVE_CHANGES_CHANNEL,
  LIVE_CHANGE_TOPICS,
  LiveChangesService,
  type LiveChangeListener,
  type LiveChangeTopic,
} from './services/LiveChangesService';
