import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ConnectionService, ProviderKeyService } from '@ci/domains/connections';

import { CreateProviderKeyInput } from '../inputs/CreateProviderKeyInput';
import { UpdateProviderKeyInput } from '../inputs/UpdateProviderKeyInput';
import { GlobalUID } from '../types/GlobalUID';
import { ProviderKeyType } from '../types/ProviderKeyType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver()
export class ProviderKeyResolver {
  constructor(
    private readonly providerKeyService: ProviderKeyService,
    private readonly connectionService: ConnectionService,
  ) {}

  @Mutation(() => ProviderKeyType)
  async createProviderKey(
    @Context() context: RequestContext,
    @Args('input') input: CreateProviderKeyInput,
  ): Promise<ProviderKeyType> {
    const serviceContext = toServiceContext(context);
    const { id: providerId } = GlobalUID.decode(input.providerId);

    const entity = await this.providerKeyService.create(serviceContext, {
      providerId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    });

    const existingConnections = await this.connectionService.search(serviceContext, {
      providerId,
      active: true,
    });

    await existingConnections.forEach(async (connection) => {
      await this.connectionService.update(serviceContext, connection.id, {
        needsReauth: true,
      });
    });

    return ProviderKeyType.toType(entity);
  }

  @Mutation(() => ProviderKeyType, { nullable: true })
  async updateProviderKey(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateProviderKeyInput,
  ): Promise<ProviderKeyType | null> {
    const serviceContext = toServiceContext(context);
    const { id: decodedId } = GlobalUID.decode(id);

    const entity = await this.providerKeyService.update(serviceContext, decodedId, input);

    const existingConnections = await this.connectionService.search(serviceContext, {
      providerId: entity!.providerId,
      active: true,
    });

    await existingConnections.forEach(async (connection) => {
      await this.connectionService.update(serviceContext, connection.id, {
        needsReauth: true,
      });
    });

    return entity ? ProviderKeyType.toType(entity) : null;
  }

  @Mutation(() => Boolean)
  async deleteProviderKey(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    const serviceContext = toServiceContext(context);
    const { id: decodedId } = GlobalUID.decode(id);

    const entity = await this.providerKeyService.findById(serviceContext, decodedId);

    const existingConnections = await this.connectionService.search(serviceContext, {
      providerId: entity!.providerId,
      active: true,
    });

    await existingConnections.forEach(async (connection) => {
      await this.connectionService.update(serviceContext, connection.id, {
        needsReauth: true,
      });
    });

    return this.providerKeyService.delete(serviceContext, decodedId);
  }
}
