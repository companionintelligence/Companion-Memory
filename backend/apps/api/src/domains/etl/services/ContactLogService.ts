import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { RequestContext } from '@ci/common/types';

import { ContactLogEntity } from '../entities/ContactLogEntity';
import { CreateContactLogDto, ContactLog } from '../types';

@Injectable()
export class ContactLogService {
  constructor(
    @InjectRepository(ContactLogEntity)
    private readonly contactLogRepository: Repository<ContactLogEntity>,
  ) {}

  async create(context: RequestContext, data: CreateContactLogDto): Promise<ContactLog> {
    const contactLog = this.contactLogRepository.create({
      id: uuidv7(),
      content: data.content,
      user: {
        id: context.userId,
      },
    });

    const entity = await this.contactLogRepository.save(contactLog);

    return entity.toContactLog();
  }

  async findAll(context: RequestContext): Promise<ContactLog[]> {
    const entities = await this.contactLogRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
    });

    return entities.map((entity) => entity.toContactLog());
  }

  async findOne(context: RequestContext, id: string): Promise<ContactLog | null> {
    const entity = await this.contactLogRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });

    return entity?.toContactLog() ?? null;
  }
}
