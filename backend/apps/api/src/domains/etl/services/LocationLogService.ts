import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { RequestContext } from '@ci/common/types';

import { LocationLogEntity } from '../entities/LocationLogEntity';
import { CreateLocationLogDto, LocationLog } from '../types';

@Injectable()
export class LocationLogService {
  constructor(
    @InjectRepository(LocationLogEntity)
    private readonly locationLogRepository: Repository<LocationLogEntity>,
  ) {}

  async create(context: RequestContext, data: CreateLocationLogDto): Promise<LocationLog> {
    const locationLog = this.locationLogRepository.create({
      id: uuidv7(),
      content: data.content,
      user: {
        id: context.userId,
      },
    });

    const entity = await this.locationLogRepository.save(locationLog);

    return entity.toLocationLog();
  }

  async findAll(context: RequestContext): Promise<LocationLog[]> {
    const entities = await this.locationLogRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
    });

    return entities.map((entity) => entity.toLocationLog());
  }

  async findOne(context: RequestContext, id: string): Promise<LocationLog | null> {
    const entity = await this.locationLogRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });

    return entity?.toLocationLog() ?? null;
  }
}
