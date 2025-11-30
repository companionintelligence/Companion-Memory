import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import { DeviceService } from '@ci/domains/devices';
import { EventService } from '@ci/domains/events';

import { BrowserActivity, BrowserActivityEntity } from '../entities/BrowserActivityEntity';
import {
  BrowserActivityCreatedEvent,
  BrowserActivityUpdatedEvent,
  BrowserActivityRemovedEvent,
} from '../events';
import type { CreateBrowserActivityDto, UpdateBrowserActivityDto } from '../types';

@Injectable()
export class BrowserActivityService {
  private logger = new LoggerService(BrowserActivityService.name);

  constructor(
    @InjectRepository(BrowserActivityEntity)
    private readonly browserActivityRepository: Repository<BrowserActivityEntity>,
    private readonly eventService: EventService,
    private readonly deviceService: DeviceService,
  ) {}

  async create(
    context: RequestContext,
    data: CreateBrowserActivityDto | CreateBrowserActivityDto[],
  ): Promise<BrowserActivity | BrowserActivity[]> {
    const isSingle = !Array.isArray(data);
    const dataArray: CreateBrowserActivityDto[] = isSingle ? [data] : data;

    this.logger.log('Creating browser activity records', {
      userId: context.userId,
      count: dataArray.length,
    });

    const returned = await Promise.all(
      dataArray.map(async (item) => {
        // Ensure device exists before creating browser activity
        await this.ensureDeviceExists(item.device_id, context);

        const browserActivity = await this.browserActivityRepository.create({
          time: new Date(item.time),
          user_id: context.userId!,
          device_id: item.device_id,
          url: item.url,
          title: item.title,
          action_type: item.action_type,
          properties: item.properties ?? {},
          duration_seconds: item.duration_seconds,
          scroll_depth_percent: item.scroll_depth_percent,
          page_summary: item.page_summary,
          page_embedding: item.page_embedding,
          category: item.category,
          productivity_score: item.productivity_score,
          is_incognito: item.is_incognito ?? false,
          contains_sensitive: item.contains_sensitive ?? false,
        });

        const result = await this.browserActivityRepository.save(browserActivity);

        await this.eventService.send(BrowserActivityCreatedEvent, {
          browserActivityId: result.id,
        });

        return BrowserActivityEntity.toEgressType(result);
      }),
    );

    this.logger.log('Successfully created browser activity records', {
      userId: context.userId,
      count: returned.length,
    });

    return isSingle ? returned[0] : returned;
  }

  async findAll(context: RequestContext): Promise<BrowserActivity[]> {
    this.logger.log('Fetching all browser activity for user', {
      userId: context.userId,
    });

    const results = await this.browserActivityRepository.find({
      where: { user_id: context.userId! },
      order: { time: 'DESC' },
    });

    return results.map((entity) => BrowserActivityEntity.toEgressType(entity));
  }

  async findByIds(context: RequestContext, ids: string[]): Promise<BrowserActivity[]> {
    this.logger.log('Fetching specific browser activity entries for user', {
      userId: context.userId,
      ids,
    });

    const results = await this.browserActivityRepository.find({
      where: {
        id: In(ids),
        user_id: context.userId!,
      },
      order: { time: 'DESC' },
    });

    return results.map((entity) => BrowserActivityEntity.toEgressType(entity));
  }

  async findById(context: RequestContext, id: string): Promise<BrowserActivity | null> {
    this.logger.log('Fetching specific browser activity entry for user', {
      userId: context.userId,
      id,
    });

    return this.browserActivityRepository.findOne({
      where: {
        id,
        user_id: context.userId!,
      },
    });
  }

  async update(
    context: RequestContext,
    id: string,
    data: UpdateBrowserActivityDto,
  ): Promise<BrowserActivity | null> {
    this.logger.log('Updating browser activity record', {
      userId: context.userId,
      id,
    });

    // Handle time field conversion if present
    const { time: timeString, ...restData } = data;
    const updateData: Record<string, unknown> = { ...restData };
    if (timeString !== undefined) {
      updateData.time = new Date(timeString);
    }

    const browserActivity = await this.browserActivityRepository.findOne({
      where: {
        id,
        user_id: context.userId!,
      },
    });

    if (!browserActivity) {
      return null;
    }

    await this.browserActivityRepository.update(
      {
        id,
        user_id: context.userId!,
      },
      updateData,
    );

    await this.eventService.send(BrowserActivityUpdatedEvent, {
      browserActivityId: browserActivity.id,
    });

    return this.findById(context, browserActivity.id);
  }

  async remove(context: RequestContext, id: string): Promise<boolean> {
    this.logger.log('Removing browser activity record', {
      userId: context.userId,
      id,
    });

    const browserActivity = await this.browserActivityRepository.findOne({
      where: {
        id,
        user_id: context.userId!,
      },
    });

    if (!browserActivity) {
      return false;
    }

    await this.browserActivityRepository.delete({
      id,
      user_id: context.userId!,
    });

    await this.eventService.send(BrowserActivityRemovedEvent, {
      browserActivityId: id,
    });

    return true;
  }

  private async ensureDeviceExists(deviceId: string, context: RequestContext): Promise<void> {
    // Check if device exists
    const device = await this.deviceService.findOne(context, deviceId);

    if (!device) {
      // Create device if it doesn't exist
      await this.deviceService.create(context, {
        device_type: 'browser',
        platform: 'web',
      });

      this.logger.log('Created new device for browser activity', {
        deviceId,
        userId: context.userId,
      });
    }
  }

  async findByTimeRange(
    context: RequestContext,
    startTime: string,
    endTime: string,
  ): Promise<BrowserActivity[]> {
    this.logger.log('Fetching browser activity for time range', {
      userId: context.userId,
      startTime,
      endTime,
    });

    const results = await this.browserActivityRepository.find({
      where: {
        user_id: context.userId!,
        time: Between(new Date(startTime), new Date(endTime)),
      },
      order: { time: 'DESC' },
    });

    return results.map((entity) => BrowserActivityEntity.toEgressType(entity));
  }

  async findByTimeAndDevice(
    context: RequestContext,
    time: string,
    deviceId: string,
  ): Promise<BrowserActivity | null> {
    const result = await this.browserActivityRepository.findOne({
      where: {
        time: new Date(time),
        user_id: context.userId!,
        device_id: deviceId,
      },
    });

    return result ? BrowserActivityEntity.toEgressType(result) : null;
  }
}
