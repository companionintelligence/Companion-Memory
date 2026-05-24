import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';

import { ProviderKeyEntity, type ProviderKey } from '../entities/ProviderKeyEntity';

export interface CreateProviderKeyDto {
  providerId: string;
  clientId: string;
  clientSecret: string;
}

export interface UpdateProviderKeyDto {
  clientId?: string;
  clientSecret?: string;
}

@Injectable()
export class ProviderKeyService {
  constructor(
    @InjectRepository(ProviderKeyEntity)
    private readonly providerKeyRepository: Repository<ProviderKeyEntity>,
  ) {}

  async findAll(context: ServiceContext): Promise<ProviderKey[]> {
    const where = context.userId === SYSTEM_USER ? {} : { userId: context.userId };

    const entities = await this.providerKeyRepository.find({ where });

    return entities.map((entity) => ProviderKeyEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<ProviderKey | null> {
    const where = context.userId === SYSTEM_USER ? { id } : { id, userId: context.userId };

    const entity = await this.providerKeyRepository.findOne({ where });

    return entity ? ProviderKeyEntity.toEgressType(entity) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(ProviderKey | null)[]> {
    const where = context.userId === SYSTEM_USER ? { id: In(ids) } : { id: In(ids), userId: context.userId };

    const entities = await this.providerKeyRepository.find({ where });

    const map = new Map(entities.map((entity) => [entity.id, ProviderKeyEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findByProviderId(context: UserServiceContext, providerId: string): Promise<ProviderKey | null> {
    const where = { providerId, userId: context.userId };

    const entity = await this.providerKeyRepository.findOne({ where });

    return entity ? ProviderKeyEntity.toEgressType(entity) : null;
  }

  async create(context: ServiceContext, data: CreateProviderKeyDto): Promise<ProviderKey> {
    const entity = this.providerKeyRepository.create({
      id: uuidv7(),
      providerId: data.providerId,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      userId: context.userId as string,
    });

    await this.providerKeyRepository.save(entity);

    return ProviderKeyEntity.toEgressType(entity);
  }

  async update(context: ServiceContext, id: string, data: UpdateProviderKeyDto): Promise<ProviderKey | null> {
    const existing = await this.findById(context, id);

    if (!existing) {
      return null;
    }

    const updateData: Partial<ProviderKeyEntity> = {};

    if (data.clientId !== undefined) {
      updateData.clientId = data.clientId;
    }

    if (data.clientSecret !== undefined) {
      updateData.clientSecret = data.clientSecret;
    }

    await this.providerKeyRepository.update(id, updateData);

    return this.findById(context, id);
  }

  async delete(context: ServiceContext, id: string): Promise<boolean> {
    const existing = await this.findById(context, id);

    if (!existing) {
      return false;
    }

    await this.providerKeyRepository.delete(id);

    return true;
  }
}
