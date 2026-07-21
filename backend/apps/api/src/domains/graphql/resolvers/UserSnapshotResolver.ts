import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtAuthGuard } from '@ci/common/guards';
import { DeviceService } from '@ci/domains/devices';
import { UserSnapshotService } from '@ci/domains/user-snapshots';

import { IngestUserSnapshotInput } from '../types/IngestUserSnapshotInput';
import { IngestUserSnapshotPayload } from '../types/IngestUserSnapshotPayload';

@UseGuards(JwtAuthGuard)
@Resolver()
export class UserSnapshotResolver {
  constructor(
    private readonly deviceService: DeviceService,
    private readonly userSnapshotService: UserSnapshotService,
  ) {}

  @Mutation(() => IngestUserSnapshotPayload)
  async ingestUserSnapshot(
    @Context() context: RequestContext,
    @Args('input') input: IngestUserSnapshotInput,
  ): Promise<IngestUserSnapshotPayload> {
    const serviceContext = toServiceContext(context);
    const device = await this.deviceService.findById(serviceContext, input.deviceId);

    if (device == null) {
      return {
        success: false,
        errorMessage: 'Device not found for the authenticated user.',
      };
    }

    await this.userSnapshotService.create(serviceContext, {
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      snapshotKind: input.snapshotKind,
      observedAt: input.observedAt,
      monotonicMs: input.monotonicMs,
      payload: input.payload,
      focusApp: input.focusApp,
      focusTitle: input.focusTitle,
      cwd: input.cwd,
      fsEventCount: input.fsEventCount,
    });

    await this.deviceService.updateLastSeen(serviceContext, input.deviceId);

    return { success: true };
  }
}
