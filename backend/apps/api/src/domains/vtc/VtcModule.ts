import { Module } from '@nestjs/common';

import { FeatureModule } from '@ci/common/feature';

import { VtcController } from './VtcController';

@Module({
  imports: [FeatureModule],
  controllers: [VtcController],
})
export class VtcModule {}
