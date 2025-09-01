import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeviceController } from './controllers/DeviceController';
import { DeviceEntity } from './entities/DeviceEntity';
import { DeviceService } from './services/DeviceService';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceEntity])],
  providers: [DeviceService],
  controllers: [DeviceController],
  exports: [DeviceService],
})
export class DevicesModule {}

// Entities
export { DeviceEntity };

// Services
export { DeviceService };

// Types
export type { Device, DeviceType, DeviceStatus, CreateDeviceDto, UpdateDeviceDto } from './types';