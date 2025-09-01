import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';

import { DeviceEntity } from '../entities/DeviceEntity';
import { DeviceDataEntity } from '../entities/DeviceDataEntity';
import { RegisterDeviceDto, UpdateDeviceDto, IngestDeviceDataDto, GetDeviceDataQueryDto } from '../types';

@Injectable()
export class DeviceService {
  constructor(
    @InjectRepository(DeviceEntity)
    private readonly deviceRepository: Repository<DeviceEntity>,
    @InjectRepository(DeviceDataEntity)
    private readonly deviceDataRepository: Repository<DeviceDataEntity>,
  ) {}

  async registerDevice(userId: string, dto: RegisterDeviceDto): Promise<DeviceEntity> {
    // Check if device already exists for this user
    const existingDevice = await this.deviceRepository.findOne({
      where: { userId, deviceIdentifier: dto.deviceIdentifier },
    });

    if (existingDevice) {
      // Update existing device
      Object.assign(existingDevice, {
        deviceName: dto.deviceName,
        platform: dto.platform,
        appVersion: dto.appVersion,
        osVersion: dto.osVersion,
        metadata: dto.metadata,
        lastActiveAt: new Date(),
      });
      return this.deviceRepository.save(existingDevice);
    }

    // Create new device
    const device = this.deviceRepository.create({
      userId,
      deviceName: dto.deviceName,
      platform: dto.platform,
      deviceIdentifier: dto.deviceIdentifier,
      appVersion: dto.appVersion,
      osVersion: dto.osVersion,
      metadata: dto.metadata,
      lastActiveAt: new Date(),
    });

    return this.deviceRepository.save(device);
  }

  async updateDevice(userId: string, deviceId: string, dto: UpdateDeviceDto): Promise<DeviceEntity> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new Error('Device not found');
    }

    Object.assign(device, {
      ...dto,
      lastActiveAt: new Date(),
    });

    return this.deviceRepository.save(device);
  }

  async getUserDevices(userId: string): Promise<DeviceEntity[]> {
    return this.deviceRepository.find({
      where: { userId },
      order: { lastActiveAt: 'DESC', createdAt: 'DESC' },
    });
  }

  async getDeviceById(userId: string, deviceId: string): Promise<DeviceEntity | null> {
    return this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });
  }

  async deleteDevice(userId: string, deviceId: string): Promise<void> {
    const result = await this.deviceRepository.delete({
      id: deviceId,
      userId,
    });

    if (result.affected === 0) {
      throw new Error('Device not found');
    }
  }

  async ingestDeviceData(deviceId: string, userId: string, dto: IngestDeviceDataDto): Promise<void> {
    // Verify device belongs to user
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new Error('Device not found');
    }

    // Create data entries
    const dataEntries = dto.data.map(item => 
      this.deviceDataRepository.create({
        deviceId,
        dataType: item.dataType,
        timestamp: item.timestamp,
        payload: item.payload,
        sourceApp: item.sourceApp,
        filePath: item.filePath,
        fileType: item.fileType,
        activityType: item.activityType,
        latitude: item.latitude,
        longitude: item.longitude,
        durationSeconds: item.durationSeconds,
      })
    );

    // Save all data entries in batch
    await this.deviceDataRepository.save(dataEntries);

    // Update device last active time
    await this.deviceRepository.update(deviceId, {
      lastActiveAt: new Date(),
    });
  }

  async getDeviceData(
    deviceId: string, 
    userId: string, 
    query: GetDeviceDataQueryDto
  ): Promise<{ data: DeviceDataEntity[]; total: number }> {
    // Verify device belongs to user
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new Error('Device not found');
    }

    // Build where clause
    const where: any = { deviceId };
    
    if (query.dataType) {
      where.dataType = query.dataType;
    }

    if (query.startTime && query.endTime) {
      where.timestamp = Between(query.startTime, query.endTime);
    } else if (query.startTime) {
      where.timestamp = new Date(query.startTime.getTime());
    } else if (query.endTime) {
      where.timestamp = new Date(query.endTime.getTime());
    }

    // Get total count
    const total = await this.deviceDataRepository.count({ where });

    // Get paginated data
    const data = await this.deviceDataRepository.find({
      where,
      order: { timestamp: 'DESC' },
      take: query.limit,
      skip: query.offset,
    });

    return { data, total };
  }

  async getDeviceDataStats(deviceId: string, userId: string): Promise<Record<string, number>> {
    // Verify device belongs to user
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new Error('Device not found');
    }

    const stats = await this.deviceDataRepository
      .createQueryBuilder('data')
      .select('data.data_type', 'dataType')
      .addSelect('COUNT(*)', 'count')
      .where('data.device_id = :deviceId', { deviceId })
      .groupBy('data.data_type')
      .getRawMany();

    return stats.reduce((acc, stat) => {
      acc[stat.dataType] = parseInt(stat.count, 10);
      return acc;
    }, {} as Record<string, number>);
  }
}