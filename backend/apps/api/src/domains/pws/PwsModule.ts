import { Module } from '@nestjs/common';

import { FeatureModule } from '@ci/common/feature';

import { PwsController } from './PwsController';

@Module({
  imports: [FeatureModule],
  controllers: [PwsController],
})
export class PwsModule {}
