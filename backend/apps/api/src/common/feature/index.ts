import { Module, Global } from '@nestjs/common';

import { FeatureController } from './controllers/FeatureController';
import { FeatureService } from './services/FeatureService';

@Global()
@Module({
  providers: [FeatureService],
  controllers: [FeatureController],
  exports: [FeatureService],
})
export class FeatureModule {}

export { FeatureService };
