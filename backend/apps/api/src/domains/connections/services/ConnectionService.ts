import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, IsNull, MoreThan, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';

import { ConnectionEntity, type Connection } from '../entities/ConnectionEntity';
import type { CreateConnectionDto, UpdateConnectionDto } from '../types';

@Injectable()
export class ConnectionService {
  constructor(
    @InjectRepository(ConnectionEntity)
    private readonly connectionRepository: Repository<ConnectionEntity>,
  ) {}

  async create(context: UserServiceContext, data: CreateConnectionDto): Promise<Connection> {
    const { providerId, ...rest } = data;

    const sanitizedData = {
      ...rest,
    };

    const instance = this.connectionRepository.create({
      ...sanitizedData,
      id: uuid7(),
      active: false,
      user: {
        id: context.userId,
      },
      provider: {
        id: providerId,
      },
      activeEndpoints: data.endpoints || [],
    });

    const entity = await this.connectionRepository.save(instance);

    // We reload the entity to ensure relations are loaded. Otherwise we
    // we encounter an error serializing this since we only have the provider
    // id at this point.
    const reloadedEntity = await this.findById(context, entity.id);

    if (!reloadedEntity) {
      throw new Error('Failed to reload connection after creation');
    }

    return reloadedEntity;
  }

  async findAll(context: ServiceContext): Promise<Connection[]> {
    const entities = await this.connectionRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        active: true,
      },
      relations: ['provider'],
    });

    return entities.map((entity) => ConnectionEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Connection | null)[]> {
    const entities = await this.connectionRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      relations: ['provider'],
    });

    const map = new Map(entities.map((entity) => [entity.id, ConnectionEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Connection | null> {
    const entity = await this.connectionRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      relations: ['provider'],
    });

    return entity ? ConnectionEntity.toEgressType(entity) : null;
  }

  async update(context: ServiceContext, id: string, data: UpdateConnectionDto): Promise<Connection | null> {
    const { syncState, endpoints, ...rest } = data;

    const currentConnection = await this.findById(context, id);
    if (!currentConnection) {
      return null;
    }

    //If endpoints are being updated, check if there are any new scopes that require reauth.
    //If so, set needsReauth to true.
    //If not, preserve the existing needsReauth value, as if we previously indicated we needed
    //reauth, we might still need it, even after multiple updates.
    //Only if there are no endpoints sent as part of the update should we use the needsReauth value
    //sent as part of the update.
    const newScopes = endpoints
      ? endpoints.some((endpoint) => currentConnection.activeEndpoints.indexOf(endpoint) === -1)
      : false;
    const needsReauth =
      currentConnection.provider!.authType === 'openid'
        ? false
        : endpoints
          ? newScopes
            ? true
            : currentConnection.needsReauth
          : rest.needsReauth;
    const result = await this.connectionRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      {
        ...rest,
        activeEndpoints: endpoints,
        needsReauth,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        syncState: syncState as any, // TypeORM will handle JSON serialization
      },
    );

    if (result.affected === 0) {
      return null;
    }

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.connectionRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      {
        active: false,
      },
    );

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return true;
  }

  async findActiveConnections() {
    const entities = await this.connectionRepository.find({
      where: [
        {
          active: true,
          accessToken: Not(IsNull()), // Must have an access token
          refreshToken: IsNull(), // No refresh token
          tokenExpiry: MoreThan(new Date()), // Token must not be expired
          provider: { id: Not(IsNull()) }, // Must have a valid provider
          needsReauth: false, // Must not require reauth
        },
        {
          active: true,
          accessToken: Not(IsNull()), // Must have an access token
          refreshToken: Not(IsNull()), //If there's a refresh token, then an expired access token can be refreshed
          provider: { id: Not(IsNull()) }, // Must have a valid provider
          needsReauth: false, // Must not require reauth
        },
        {
          active: true,
          accessToken: Not(IsNull()),
          provider: {
            id: Not(IsNull()),
            authType: 'openid',
          },
        },
      ],
      relations: ['user', 'provider'],
    });

    return entities.map((entity) => ({
      connection: ConnectionEntity.toEgressType(entity),
      lastSyncedAt: entity.syncState?.lastSyncedAt ? new Date(entity.syncState.lastSyncedAt as string) : null,
    }));
  }

  async search(context: ServiceContext, filters: Partial<Connection>): Promise<Connection[]> {
    const whereClause: Record<string, unknown> = {
      ...filters,
      ...(context.userId !== SYSTEM_USER && {
        user: {
          id: context.userId,
        },
      }),
    };

    const entities = await this.connectionRepository.find({
      where: whereClause,
      relations: ['provider'],
    });

    return entities.map((entity) => ConnectionEntity.toEgressType(entity));
  }
}
