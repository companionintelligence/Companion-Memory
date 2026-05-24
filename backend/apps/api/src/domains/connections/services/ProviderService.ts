import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { type ServiceContext } from '@ci/common/context';

import { ProviderEntity, type Provider } from '../entities/ProviderEntity';

@Injectable()
export class ProviderService {
  constructor(
    @InjectRepository(ProviderEntity)
    private readonly providerRepository: Repository<ProviderEntity>,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async findAll(context: ServiceContext): Promise<Provider[]> {
    const entities = await this.providerRepository.find();

    return entities.map((entity) => ProviderEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<Provider | null> {
    const entity = await this.providerRepository.findOne({
      where: {
        id,
      },
    });

    return entity ? ProviderEntity.toEgressType(entity) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Provider | null)[]> {
    const entities = await this.providerRepository.find({
      where: {
        id: In(ids),
      },
    });

    const map = new Map(entities.map((entity) => [entity.id, ProviderEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }
}
