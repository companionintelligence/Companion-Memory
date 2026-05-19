import { Global, Module } from '@nestjs/common';

import { PubSubService } from './PubSubService';

/**
 * Global so any domain can publish/subscribe without explicitly importing
 * PubSubModule. The actual transport is in-memory today (plan 05 §3.1);
 * swap-in for Postgres LISTEN happens transparently here when we go
 * multi-process.
 */
@Global()
@Module({
  providers: [PubSubService],
  exports: [PubSubService],
})
export class PubSubModule {}
