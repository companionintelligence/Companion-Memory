import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { PairingService } from '@ci/domains/pairing';

import { PairingStatusPayload } from '../types/PairingStatusPayload';
import { StartPairingPayload } from '../types/StartPairingPayload';

@Resolver()
export class PairingResolver {
  constructor(private readonly pairingService: PairingService) {}

  @Mutation(() => StartPairingPayload)
  async startPairing(): Promise<StartPairingPayload> {
    const { pairingToken, pollKey } = await this.pairingService.startPairing();

    return {
      success: true,
      pairingToken,
      pollKey,
      pairingPath: `/pair?token=${pairingToken}`,
    };
  }

  @Query(() => PairingStatusPayload)
  async pairingStatus(
    @Args('pairingToken') pairingToken: string,
    @Args('pollKey') pollKey: string,
  ): Promise<PairingStatusPayload> {
    const result = await this.pairingService.getStatus(pairingToken, pollKey);

    if (result.status === 'NOT_FOUND') {
      return { success: false, status: 'NOT_FOUND', errorMessage: 'Pairing not found.' };
    }

    if (result.status === 'EXPIRED') {
      return { success: false, status: 'EXPIRED', errorMessage: 'Pairing has expired.' };
    }

    return {
      success: true,
      status: result.status,
      userId: result.userId,
      userName: result.userName,
      userEmail: result.userEmail,
      deviceId: result.deviceId,
      appletAccessToken: result.accessToken,
    };
  }
}
