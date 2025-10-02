import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ContactLogController } from './controllers/ContactLogController';
import { LocationLogController } from './controllers/LocationLogController';
import { ContactLogEntity } from './entities/ContactLogEntity';
import { LocationLogEntity } from './entities/LocationLogEntity';
import { ContactLogService } from './services/ContactLogService';
import { LocationLogService } from './services/LocationLogService';

@Module({
  imports: [TypeOrmModule.forFeature([ContactLogEntity, LocationLogEntity])],
  providers: [ContactLogService, LocationLogService],
  controllers: [ContactLogController, LocationLogController],
  exports: [],
})
export class EtlModule {}

// Entities
export { ContactLogEntity, LocationLogEntity };

// Services
export { ContactLogService, LocationLogService };

// Controllers
export { ContactLogController, LocationLogController };

// Types
export * from './types';
