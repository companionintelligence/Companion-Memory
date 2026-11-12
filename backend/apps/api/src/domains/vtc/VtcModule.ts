import { Module } from '@nestjs/common';

import { FeatureModule } from '@ci/common/feature';

import { VtcController } from './VtcController';

@Module({
  imports: [FeatureModule],
  controllers: [VtcController],
  exports: [VtcController],
})
export class VtcModule {}
