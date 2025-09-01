import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { randomUUID } from 'node:crypto';

import type { CreateDeviceDto, UpdateDeviceDto, Device } from '../types';
import { DeviceEntity } from '../entities/DeviceEntity';

@Injectable()
export class DeviceService {
  constructor(
    @InjectRepository(DeviceEntity)
    private readonly deviceRepository: Repository<DeviceEntity>,
  ) {}

  async findAll(userId: string): Promise<Device[]> {
    const devices = await this.deviceRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    return devices.map((device) => device.toDevice());
  }

  async findOne(id: string, userId: string): Promise<Device> {
    const device = await this.deviceRepository.findOne({
      where: { id, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return device.toDevice();
  }

  async create(createDeviceDto: CreateDeviceDto, userId: string): Promise<Device> {
    const deviceEntity = this.deviceRepository.create({
      id: randomUUID(),
      ...createDeviceDto,
      userId,
      status: 'disconnected',
    });

    const savedDevice = await this.deviceRepository.save(deviceEntity);
    return savedDevice.toDevice();
  }

  async update(id: string, updateDeviceDto: UpdateDeviceDto, userId: string): Promise<Device> {
    const device = await this.deviceRepository.findOne({
      where: { id, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    Object.assign(device, updateDeviceDto);
    const savedDevice = await this.deviceRepository.save(device);
    return savedDevice.toDevice();
  }

  async remove(id: string, userId: string): Promise<void> {
    const device = await this.deviceRepository.findOne({
      where: { id, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    await this.deviceRepository.remove(device);
  }

  async updateLastSeen(id: string, userId: string): Promise<void> {
    await this.deviceRepository.update(
      { id, userId },
      { lastSeen: new Date(), status: 'connected' }
    );
  }

  async updateStatus(id: string, status: 'connected' | 'disconnected' | 'authorized' | 'unauthorized', userId: string): Promise<void> {
    await this.deviceRepository.update(
      { id, userId },
      { status }
    );
  }
}