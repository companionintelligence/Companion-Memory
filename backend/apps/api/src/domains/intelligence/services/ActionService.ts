import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { RequestContext } from '@ci/common/types';

import { ActionEntity } from '../entities/ActionEntity';
import type { Action } from '../types';

@Injectable()
export class ActionService {
  constructor(
    @InjectRepository(ActionEntity)
    private readonly actionRepository: Repository<ActionEntity>,
  ) {}

  async findAll(context: RequestContext): Promise<Action[]> {
    const result = await this.actionRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
      relations: ['tags'],
    });

    return result.map((entity) => entity.toAction());
  }

  async findOne(context: RequestContext, id: string): Promise<Action | null> {
    const result = await this.actionRepository.findOne({
      where: {
        user: {
          id: context.userId,
        },
        id,
      },
      relations: ['tags'],
    });

    return result?.toAction() ?? null;
  }
}
