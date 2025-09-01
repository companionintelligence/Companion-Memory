import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/types';

import { SavedSearchEntity } from '../entities/SavedSearchEntity';
import { TagEntity } from '../entities/TagEntity';

export interface CreateSavedSearchDto {
  name: string;
  query: string;
  description?: string;
  filters?: Record<string, any>;
  is_smart_search?: boolean;
  tags?: string[];
}

export interface UpdateSavedSearchDto {
  name?: string;
  query?: string;
  description?: string;
  filters?: Record<string, any>;
  is_smart_search?: boolean;
  tags?: string[];
}

@Injectable()
export class SavedSearchService {
  constructor(
    @InjectRepository(SavedSearchEntity)
    private savedSearchRepo: Repository<SavedSearchEntity>,
    @InjectRepository(TagEntity)
    private tagRepo: Repository<TagEntity>,
  ) {}

  async findAll(context: RequestContext) {
    return this.savedSearchRepo.find({
      where: {
        user: { id: context.userId },
      },
      relations: ['tags'],
      order: { created_at: 'DESC' },
    });
  }

  async findById(context: RequestContext, id: string) {
    return this.savedSearchRepo.findOne({
      where: {
        id,
        user: { id: context.userId },
      },
      relations: ['tags'],
    });
  }

  async create(context: RequestContext, dto: CreateSavedSearchDto) {
    const savedSearch = this.savedSearchRepo.create({
      id: uuidv7(),
      name: dto.name,
      query: dto.query,
      description: dto.description,
      filters: dto.filters,
      is_smart_search: dto.is_smart_search || false,
      user: { id: context.userId },
    });

    if (dto.tags && dto.tags.length > 0) {
      savedSearch.tags = await this.findOrCreateTags(context, dto.tags);
    }

    return this.savedSearchRepo.save(savedSearch);
  }

  async update(context: RequestContext, id: string, dto: UpdateSavedSearchDto) {
    const savedSearch = await this.findById(context, id);
    if (!savedSearch) {
      throw new Error('Saved search not found');
    }

    if (dto.name !== undefined) savedSearch.name = dto.name;
    if (dto.query !== undefined) savedSearch.query = dto.query;
    if (dto.description !== undefined) savedSearch.description = dto.description;
    if (dto.filters !== undefined) savedSearch.filters = dto.filters;
    if (dto.is_smart_search !== undefined) savedSearch.is_smart_search = dto.is_smart_search;

    if (dto.tags !== undefined) {
      savedSearch.tags = dto.tags.length > 0 ? await this.findOrCreateTags(context, dto.tags) : [];
    }

    return this.savedSearchRepo.save(savedSearch);
  }

  async delete(context: RequestContext, id: string) {
    const result = await this.savedSearchRepo.delete({
      id,
      user: { id: context.userId },
    });

    return (result.affected ?? 0) > 0;
  }

  private async findOrCreateTags(context: RequestContext, tagLabels: string[]): Promise<TagEntity[]> {
    const normalizedLabels = tagLabels.map(label => label.toLowerCase());
    
    // Find existing tags
    const existingTags = await this.tagRepo.find({
      where: {
        label: In(normalizedLabels),
        user: { id: context.userId },
      },
    });

    const existingLabels = existingTags.map(tag => tag.label);
    const newLabels = normalizedLabels.filter(label => !existingLabels.includes(label));

    // Create new tags
    const newTags = await Promise.all(
      newLabels.map(label =>
        this.tagRepo.save({
          id: uuidv7(),
          label,
          user: { id: context.userId },
        })
      )
    );

    return [...existingTags, ...newTags];
  }

  async getTagSuggestions(context: RequestContext): Promise<string[]> {
    const tags = await this.tagRepo.find({
      where: {
        user: { id: context.userId },
      },
      select: ['label'],
      order: { created_at: 'DESC' },
      take: 20,
    });

    return tags.map(tag => tag.label).filter((label): label is string => Boolean(label));
  }
}