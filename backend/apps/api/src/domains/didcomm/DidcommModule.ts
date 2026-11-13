import { Module } from '@nestjs/common';

import { FeatureModule } from '@ci/common/feature';

import { DidcommController } from './DidcommController';

@Module({
  imports: [FeatureModule],
  controllers: [DidcommController],
})
export class DidcommModule {}
