import { Injectable } from '@nestjs/common';

import config from '@ci/configuration';

@Injectable()
export class FeatureService {
  private features = config.features;

  async isFeatureEnabled(name: keyof typeof this.features): Promise<boolean> {
    return this.features[name] === true;
  }

  async getAllFeatures(): Promise<typeof this.features> {
    return this.features;
  }
}
