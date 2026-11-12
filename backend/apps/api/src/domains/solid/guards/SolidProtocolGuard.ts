import { type CanActivate, Injectable, NotFoundException } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';

/**
 * Ensures Solid protocol routes fail closed (404 NotFoundException) BEFORE auth guards run
 * when `solid.protocol` is disabled.
 */
@Injectable()
export class SolidProtocolGuard implements CanActivate {
  constructor(private readonly features: FeatureService) {}

  async canActivate(): Promise<boolean> {
    if (!(await this.features.isFeatureEnabled('solid.protocol'))) {
      throw new NotFoundException();
    }

    return true;
  }
}
