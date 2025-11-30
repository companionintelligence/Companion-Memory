import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';

import { DeviceEntity } from '../entities/DeviceEntity';
import type { CreateDeviceDto, UpdateDeviceDto, Device } from '../types';

@Injectable()
export class DeviceService {
  private logger = new LoggerService(DeviceService.name);

  constructor(
    @InjectRepository(DeviceEntity)
    private readonly deviceRepository: Repository<DeviceEntity>,
  ) {}

  async create(
    context: RequestContext,
    data: CreateDeviceDto | CreateDeviceDto[],
  ): Promise<Device | Device[]> {
    const isSingle = !Array.isArray(data);
    const dataArray: CreateDeviceDto[] = isSingle ? [data] : data;

    this.logger.log('Creating device records', {
      userId: context.userId,
      count: dataArray.length,
    });

    const returned = await Promise.all(
      dataArray.map(async (item) => {
        const device = await this.deviceRepository.create({
          device_id: uuid7(),
          user_id: context.userId!,
          device_entity_id: item.device_entity_id,
          device_name: item.device_name ?? `${item.device_type} Device`,
          device_type: item.device_type,
          platform: item.platform,
          model: item.model,
          manufacturer: item.manufacturer,
          os_version: item.os_version,
          app_version: item.app_version,
          is_active: item.is_active ?? true,
          is_primary: item.is_primary ?? false,
          push_token: item.push_token,
          capabilities: item.capabilities ?? {},
          privacy_settings: item.privacy_settings ?? {},
        });

        const result = await this.deviceRepository.save(device);

        return result.toDevice();
      }),
    );

    this.logger.log('Successfully created device records', {
      userId: context.userId,
      count: returned.length,
    });

    return isSingle ? returned[0] : returned;
  }

  async findAll(context: RequestContext): Promise<Device[]> {
    this.logger.log('Fetching all devices for user', {
      userId: context.userId,
    });

    const results = await this.deviceRepository.find({
      where: { user_id: context.userId! },
      order: { created_at: 'DESC' },
    });

    return results.map((entity) => entity.toDevice());
  }

  async findOne(context: RequestContext, deviceId: string): Promise<Device | null> {
    const result = await this.deviceRepository.findOne({
      where: {
        device_id: deviceId,
        user_id: context.userId!,
      },
    });

    return result?.toDevice() ?? null;
  }

  async update(context: RequestContext, deviceId: string, data: UpdateDeviceDto): Promise<Device | null> {
    this.logger.log('Updating device record', {
      userId: context.userId,
      deviceId,
    });

    const updateData: Partial<DeviceEntity> = {};

    if (data.device_entity_id !== undefined) {
      updateData.device_entity_id = data.device_entity_id;
    }

    if (data.device_name !== undefined) {
      updateData.device_name = data.device_name;
    }

    if (data.device_type !== undefined) {
      updateData.device_type = data.device_type;
    }

    if (data.platform !== undefined) {
      updateData.platform = data.platform;
    }

    if (data.model !== undefined) {
      updateData.model = data.model;
    }

    if (data.manufacturer !== undefined) {
      updateData.manufacturer = data.manufacturer;
    }

    if (data.os_version !== undefined) {
      updateData.os_version = data.os_version;
    }

    if (data.app_version !== undefined) {
      updateData.app_version = data.app_version;
    }

    if (data.is_active !== undefined) {
      updateData.is_active = data.is_active;
    }

    if (data.is_primary !== undefined) {
      updateData.is_primary = data.is_primary;
    }

    if (data.push_token !== undefined) {
      updateData.push_token = data.push_token;
    }

    if (data.capabilities !== undefined) {
      updateData.capabilities = data.capabilities;
    }

    if (data.privacy_settings !== undefined) {
      updateData.privacy_settings = data.privacy_settings;
    }

    // Use save method for JSONB fields to avoid TypeScript issues
    const device = await this.deviceRepository.findOne({
      where: {
        device_id: deviceId,
        user_id: context.userId!,
      },
    });

    if (device) {
      Object.assign(device, updateData);
      await this.deviceRepository.save(device);
    }

    return this.findOne(context, deviceId);
  }

  async remove(context: RequestContext, deviceId: string): Promise<void> {
    this.logger.log('Removing device record', {
      userId: context.userId,
      deviceId,
    });

    await this.deviceRepository.delete({
      device_id: deviceId,
      user_id: context.userId!,
    });
  }

  async setPrimary(context: RequestContext, deviceId: string): Promise<Device | null> {
    this.logger.log('Setting device as primary', {
      userId: context.userId,
      deviceId,
    });

    // First, unset all other devices as primary
    await this.deviceRepository.update({ user_id: context.userId! }, { is_primary: false });

    // Then set this device as primary
    await this.deviceRepository.update(
      {
        device_id: deviceId,
        user_id: context.userId!,
      },
      { is_primary: true },
    );

    return this.findOne(context, deviceId);
  }

  async updateLastSeen(context: RequestContext, deviceId: string): Promise<Device | null> {
    this.logger.log('Updating device last seen', {
      userId: context.userId,
      deviceId,
    });

    await this.deviceRepository.update(
      {
        device_id: deviceId,
        user_id: context.userId!,
      },
      { last_seen: new Date() },
    );

    return this.findOne(context, deviceId);
  }

  /**
   * Get or create a device for the user. If a device with the given ID exists, return it.
   * Otherwise, create a new device with the provided or default settings.
   */
  async getOrCreateDevice(
    context: RequestContext,
    deviceId?: string,
    deviceData?: Partial<CreateDeviceDto>,
  ): Promise<Device> {
    // If deviceId is provided, try to find existing device
    if (deviceId) {
      const existingDevice = await this.findOne(context, deviceId);
      if (existingDevice) {
        return existingDevice;
      }
    }

    // Find primary device or first active device as fallback
    const existingDevices = await this.findAll(context);
    const primaryDevice = existingDevices.find((d) => d.is_primary);
    if (primaryDevice) {
      return primaryDevice;
    }

    const activeDevice = existingDevices.find((d) => d.is_active);
    if (activeDevice) {
      return activeDevice;
    }

    // Create a new device with provided data or defaults
    const defaultDeviceData: CreateDeviceDto = {
      device_type: deviceData?.device_type ?? 'browser',
      platform: deviceData?.platform ?? 'web',
      device_name: deviceData?.device_name,
      ...deviceData,
    };

    const newDevice = await this.create(context, defaultDeviceData);

    return Array.isArray(newDevice) ? newDevice[0] : newDevice;
  }
}
