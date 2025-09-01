import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeviceEntity } from './entities/DeviceEntity';
import { DeviceDataEntity } from './entities/DeviceDataEntity';
import { DeviceController } from './controllers/DeviceController';
import { DeviceService } from './services/DeviceService';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeviceEntity, DeviceDataEntity]),
  ],
  controllers: [DeviceController],
  providers: [DeviceService],
  exports: [DeviceService],
})
export class DevicesModule {}