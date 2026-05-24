import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';

import { DeviceController } from './controllers/DeviceController';
import { DeviceEntity } from './entities/DeviceEntity';
import { DeviceService } from './services/DeviceService';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceEntity]), EventsModule],
  providers: [DeviceService],
  controllers: [DeviceController],
  exports: [DeviceService],
})
export class DeviceModule {}

// Entities
export { DeviceEntity };

// Services
export { DeviceService };

// Controllers
export { DeviceController };

// Types
export * from './types';
