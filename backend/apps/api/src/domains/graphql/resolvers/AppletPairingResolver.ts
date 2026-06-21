import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { AppletPairingService } from '@ci/domains/applet-pairing';

import { ApproveAppletPairingPayload } from '../types/ApproveAppletPairingPayload';
import { IngestUserSnapshotInput } from '../types/IngestUserSnapshotInput';
import { IngestUserSnapshotPayload } from '../types/IngestUserSnapshotPayload';
import { PairingStatusPayload } from '../types/PairingStatusPayload';
import { StartPairingPayload } from '../types/StartPairingPayload';

/**
 * Companion applet pairing + activity ingest.
 *
 * `startPairing` and `pairingStatus` are intentionally unauthenticated (the
 * applet has no credentials yet); they are secured by the unguessable
 * pairing/poll tokens. `approveAppletPairing` and `ingestUserSnapshot` require
 * an authenticated principal (a signed-in user, and the paired applet's token,
 * respectively).
 */
@Resolver()
export class AppletPairingResolver {
  constructor(private readonly appletPairingService: AppletPairingService) {}

  @Mutation(() => StartPairingPayload)
  async startPairing(): Promise<StartPairingPayload> {
    const pairing = await this.appletPairingService.start();

    return {
      success: true,
      pairingToken: pairing.pairing_token,
      pollKey: pairing.poll_key,
      pairingPath: `/pair?token=${pairing.pairing_token}`,
      errorMessage: null,
    };
  }

  @Query(() => PairingStatusPayload)
  async pairingStatus(
    @Args('pairingToken', { type: () => String }) pairingToken: string,
    @Args('pollKey', { type: () => String }) pollKey: string,
  ): Promise<PairingStatusPayload> {
    const pairing = await this.appletPairingService.status(pairingToken, pollKey);

    if (!pairing) {
      return { success: true, status: 'NOT_FOUND', errorMessage: null };
    }

    if (this.appletPairingService.isExpired(pairing)) {
      return { success: true, status: 'EXPIRED', errorMessage: null };
    }

    if (pairing.status !== 'COMPLETED') {
      return { success: true, status: 'PENDING', errorMessage: null };
    }

    return {
      success: true,
      status: 'COMPLETED',
      userId: pairing.user_id ?? null,
      userName: pairing.user_name ?? null,
      userEmail: pairing.user_email ?? null,
      deviceId: pairing.device_id ?? null,
      appletAccessToken: pairing.applet_access_token ?? null,
      errorMessage: null,
    };
  }

  @Mutation(() => ApproveAppletPairingPayload)
  @UseGuards(JwtOrApiKeyAuthGuard)
  async approveAppletPairing(
    @Args('pairingToken', { type: () => String }) pairingToken: string,
    @Context() context: RequestContext,
  ): Promise<ApproveAppletPairingPayload> {
    const { userId } = toServiceContext(context);
    const pairing = await this.appletPairingService.approve(pairingToken, userId);

    if (!pairing) {
      return { success: false, errorMessage: 'Pairing not found, already used, or expired.' };
    }

    return { success: true, deviceId: pairing.device_id ?? null, errorMessage: null };
  }

  @Mutation(() => IngestUserSnapshotPayload)
  @UseGuards(JwtOrApiKeyAuthGuard)
  async ingestUserSnapshot(
    @Args('input') input: IngestUserSnapshotInput,
    @Context() context: RequestContext,
  ): Promise<IngestUserSnapshotPayload> {
    const { userId } = toServiceContext(context);
    await this.appletPairingService.recordSnapshot(userId, input);

    return { success: true, errorMessage: null };
  }
}
