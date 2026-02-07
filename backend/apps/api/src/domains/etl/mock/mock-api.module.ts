import { Module } from '@nestjs/common';
import { MockApiController } from './mock-api.controller';
import { MockApiService } from './mock-api.service';

@Module({
  controllers: [MockApiController],
  providers: [MockApiService],
  exports: [MockApiService],
})
export class MockApiModule {}
