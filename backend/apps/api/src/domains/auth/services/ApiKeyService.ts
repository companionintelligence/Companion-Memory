import { createHash, randomBytes } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';

import { ApiKey, ApiKeyEntity } from '../entities/ApiKeyEntity';
import type { CreateApiKeyDto, CreateApiKeyResponse, UpdateApiKeyDto } from '../types';

const API_KEY_BYTE_LENGTH = 32;
const API_KEY_HEX_LENGTH = API_KEY_BYTE_LENGTH * 2;
const API_KEY_HEX_REGEX = /^[0-9a-f]+$/;
const PREFIX_LENGTH = 5;

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(ApiKeyEntity)
    private readonly apiKeyRepository: Repository<ApiKeyEntity>,
  ) {}

  async create(context: UserServiceContext, data: CreateApiKeyDto): Promise<CreateApiKeyResponse> {
    const rawKey = randomBytes(API_KEY_BYTE_LENGTH).toString('hex');
    const prefix = rawKey.substring(0, PREFIX_LENGTH);
    const hashedKey = this.hash(rawKey);

    const entity = this.apiKeyRepository.create({
      id: uuidv7(),
      name: data.name,
      prefix,
      hashed_key: hashedKey,
      scopes: data.scopes ?? [],
      expires_at: data.expires_at ? new Date(data.expires_at) : null,
      user_id: context.userId,
    });

    const saved = await this.apiKeyRepository.save(entity);

    return {
      ...ApiKeyEntity.toEgressType(saved),
      key: rawKey,
    };
  }

  async findAllByUser(context: ServiceContext): Promise<ApiKey[]> {
    const keys = await this.apiKeyRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && { user_id: context.userId }),
      },
      order: { created_at: 'DESC' },
    });

    return keys.map(ApiKeyEntity.toEgressType);
  }

  async findOneByUser(context: ServiceContext, keyId: string): Promise<ApiKey | null> {
    const key = await this.apiKeyRepository.findOne({
      where: {
        id: keyId,
        ...(context.userId !== SYSTEM_USER && { user_id: context.userId }),
      },
    });

    return key ? ApiKeyEntity.toEgressType(key) : null;
  }

  async update(context: ServiceContext, keyId: string, data: UpdateApiKeyDto): Promise<ApiKey | null> {
    const key = await this.apiKeyRepository.findOne({
      where: {
        id: keyId,
        ...(context.userId !== SYSTEM_USER && { user_id: context.userId }),
      },
    });

    if (!key) {
      return null;
    }

    if (data.name !== undefined) {
      key.name = data.name;
    }

    if (data.scopes !== undefined) {
      key.scopes = data.scopes;
    }

    const saved = await this.apiKeyRepository.save(key);

    return ApiKeyEntity.toEgressType(saved);
  }

  async remove(context: ServiceContext, keyId: string): Promise<boolean> {
    const result = await this.apiKeyRepository.delete({
      id: keyId,
      ...(context.userId !== SYSTEM_USER && { user_id: context.userId }),
    });

    return (result.affected ?? 0) > 0;
  }

  async validateKey(rawKey: string): Promise<{ userId: string } | null> {
    if (rawKey.length !== API_KEY_HEX_LENGTH || !API_KEY_HEX_REGEX.test(rawKey)) {
      return null;
    }

    const hashed = this.hash(rawKey);

    const key = await this.apiKeyRepository.findOne({
      where: { hashed_key: hashed },
      select: ['id', 'user_id', 'expires_at'],
    });

    if (!key) {
      return null;
    }

    if (key.expires_at && key.expires_at < new Date()) {
      return null;
    }

    await this.apiKeyRepository.update(key.id, { last_used_at: new Date() });

    return { userId: key.user_id };
  }

  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }
}
