import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { ProviderEntity } from '../entities/ProviderEntity';
import type { CreateProviderDto, Provider, UpdateProviderDto } from '../types';

@Injectable()
export class ProviderService {
  constructor(
    @InjectRepository(ProviderEntity)
    private readonly providerRepository: Repository<ProviderEntity>,
  ) {}

  async create(data: CreateProviderDto): Promise<Provider> {
    const instance = this.providerRepository.create({
      ...data,
      id: uuid7(),
    });

    const entity = await this.providerRepository.save(instance);

    return entity.toProvider();
  }

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

  async update(id: string, data: UpdateProviderDto): Promise<Provider> {
    const result = await this.providerRepository.update(id, data);

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return this.findOne(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.providerRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return true;
  }
}
