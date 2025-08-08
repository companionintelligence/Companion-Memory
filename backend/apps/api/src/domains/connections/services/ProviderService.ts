import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProviderEntity } from '../entities/ProviderEntity';
import type { Provider } from '../types';

@Injectable()
export class ProviderService {
  constructor(
    @InjectRepository(ProviderEntity)
    private readonly providerRepository: Repository<ProviderEntity>,
  ) {}

  async findAll(): Promise<Provider[]> {
    const entities = await this.providerRepository.find();

    return entities.map((entity) => entity.toProvider());
  }

  async findOne(id: string): Promise<Provider> {
    const entity = await this.providerRepository.findOne({
      where: {
        id,
      },
    });

    if (entity == null) {
      throw new NotFoundException();
    }

    return entity.toProvider();
  }
}
