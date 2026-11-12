import { Module } from '@nestjs/common';

import { FeatureModule } from '@ci/common/feature';

import { IdentikeyController } from './IdentikeyController';

@Module({
  imports: [FeatureModule],
  controllers: [IdentikeyController],
  exports: [IdentikeyController],
})
export class IdentikeyModule {}
