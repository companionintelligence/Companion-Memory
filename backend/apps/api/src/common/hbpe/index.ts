import { Global, Module } from '@nestjs/common';

import { LoggingModule } from '@ci/common/logging';

import { HbpeNotifyService } from './HbpeNotifyService';

@Global()
@Module({
  imports: [LoggingModule],
  providers: [HbpeNotifyService],
  exports: [HbpeNotifyService],
})
export class HbpeNotifyModule {}

export { HbpeNotifyService, HBPE_NOTIFY_CHANNELS, utcDay } from './HbpeNotifyService';
export type { HbpeNotifyChannel } from './HbpeNotifyService';
