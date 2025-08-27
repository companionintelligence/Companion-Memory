import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeleteResult, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { RequestContext } from '@ci/common/types';

import { EventEntity } from '../entities/EventEntity';
import { CreateEventDto, UpdateEventDto, Event } from '../types';

@Injectable()
export class EventService {
  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
  ) {}

  async create(context: RequestContext, data: CreateEventDto | CreateEventDto[]): Promise<Event | Event[]> {
    const isSingle = !Array.isArray(data);
    const dataArray: CreateEventDto[] = isSingle ? [data] : data;

    const returned = await Promise.all(
      dataArray.map(async (item) => {
        const event = await this.eventRepository.create({
          ...item,
          id: uuidv7(),
        });
        const eventResult = await this.eventRepository.save(event);

        return eventResult.toEvent();
      }),
    );

    return isSingle ? returned[0] : returned;
  }

  async findAll(context: RequestContext): Promise<Event[]> {
    const result = await this.eventRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
    });

    return result.map((entity) => entity.toEvent());
  }

  async findOne(context: RequestContext, id: string): Promise<Event | null> {
    const result = await this.eventRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });

    return result?.toEvent() ?? null;
  }

  async update(context: RequestContext, id: string, data: UpdateEventDto): Promise<Event | null> {
    await this.eventRepository.update(id, data);

    return this.findOne(context, id);
  }

  remove(id: string): Promise<DeleteResult> {
    return this.eventRepository.delete(id);
  }
}
