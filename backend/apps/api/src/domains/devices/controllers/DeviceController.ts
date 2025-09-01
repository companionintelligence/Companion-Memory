import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';

import { DeviceService } from '../services/DeviceService';
import { 
  RegisterDeviceSchema, 
  UpdateDeviceSchema, 
  IngestDeviceDataSchema, 
  GetDeviceDataQuerySchema,
  RegisterDeviceDto,
  UpdateDeviceDto,
  IngestDeviceDataDto,
  GetDeviceDataQueryDto
} from '../types';

@Controller('devices')
@UseGuards(JwtAuthGuard)
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  @Post('register')
  async registerDevice(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(RegisterDeviceSchema)) dto: RegisterDeviceDto
  ) {
    try {
      const device = await this.deviceService.registerDevice(context.userId!, dto);
      return {
        success: true,
        device: {
          id: device.id,
          deviceName: device.deviceName,
          platform: device.platform,
          deviceIdentifier: device.deviceIdentifier,
          appVersion: device.appVersion,
          osVersion: device.osVersion,
          metadata: device.metadata,
          lastActiveAt: device.lastActiveAt,
          createdAt: device.createdAt,
          updatedAt: device.updatedAt,
        },
      };
    } catch (error) {
      if (error instanceof QueryFailedError && error.message.includes('unique constraint')) {
        throw new ConflictException('Device identifier already exists for another user');
      }
      throw error;
    }
  }

  @Get()
  async getUserDevices(@Context() context: RequestContext) {
    const devices = await this.deviceService.getUserDevices(context.userId!);
    return {
      success: true,
      devices: devices.map(device => ({
        id: device.id,
        deviceName: device.deviceName,
        platform: device.platform,
        deviceIdentifier: device.deviceIdentifier,
        appVersion: device.appVersion,
        osVersion: device.osVersion,
        metadata: device.metadata,
        lastActiveAt: device.lastActiveAt,
        createdAt: device.createdAt,
        updatedAt: device.updatedAt,
      })),
    };
  }

  @Get(':deviceId')
  async getDevice(
    @Context() context: RequestContext,
    @Param('deviceId') deviceId: string
  ) {
    try {
      const device = await this.deviceService.getDeviceById(context.userId!, deviceId);
      if (!device) {
        throw new NotFoundException('Device not found');
      }

      return {
        success: true,
        device: {
          id: device.id,
          deviceName: device.deviceName,
          platform: device.platform,
          deviceIdentifier: device.deviceIdentifier,
          appVersion: device.appVersion,
          osVersion: device.osVersion,
          metadata: device.metadata,
          lastActiveAt: device.lastActiveAt,
          createdAt: device.createdAt,
          updatedAt: device.updatedAt,
        },
      };
    } catch (error: any) {
      if (error.message === 'Device not found') {
        throw new NotFoundException('Device not found');
      }
      throw error;
    }
  }

  @Put(':deviceId')
  async updateDevice(
    @Context() context: RequestContext,
    @Param('deviceId') deviceId: string,
    @Body(new ValidationPipe(UpdateDeviceSchema)) dto: UpdateDeviceDto
  ) {
    try {
      const device = await this.deviceService.updateDevice(context.userId!, deviceId, dto);
      return {
        success: true,
        device: {
          id: device.id,
          deviceName: device.deviceName,
          platform: device.platform,
          deviceIdentifier: device.deviceIdentifier,
          appVersion: device.appVersion,
          osVersion: device.osVersion,
          metadata: device.metadata,
          lastActiveAt: device.lastActiveAt,
          createdAt: device.createdAt,
          updatedAt: device.updatedAt,
        },
      };
    } catch (error: any) {
      if (error.message === 'Device not found') {
        throw new NotFoundException('Device not found');
      }
      throw error;
    }
  }

  @Delete(':deviceId')
  async deleteDevice(
    @Context() context: RequestContext,
    @Param('deviceId') deviceId: string
  ) {
    try {
      await this.deviceService.deleteDevice(context.userId!, deviceId);
      return { success: true, message: 'Device deleted successfully' };
    } catch (error: any) {
      if (error.message === 'Device not found') {
        throw new NotFoundException('Device not found');
      }
      throw error;
    }
  }

  @Post(':deviceId/data')
  async ingestDeviceData(
    @Context() context: RequestContext,
    @Param('deviceId') deviceId: string,
    @Body(new ValidationPipe(IngestDeviceDataSchema)) dto: IngestDeviceDataDto
  ) {
    try {
      await this.deviceService.ingestDeviceData(deviceId, context.userId!, dto);
      return { 
        success: true, 
        message: `Successfully ingested ${dto.data.length} data points`,
        ingested: dto.data.length
      };
    } catch (error: any) {
      if (error.message === 'Device not found') {
        throw new NotFoundException('Device not found');
      }
      throw error;
    }
  }

  @Get(':deviceId/data')
  async getDeviceData(
    @Context() context: RequestContext,
    @Param('deviceId') deviceId: string,
    @Query(new ValidationPipe(GetDeviceDataQuerySchema)) query: GetDeviceDataQueryDto
  ) {
    try {
      const result = await this.deviceService.getDeviceData(deviceId, context.userId!, query);
      return {
        success: true,
        data: result.data.map(item => ({
          id: item.id,
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
          createdAt: item.createdAt,
        })),
        pagination: {
          total: result.total,
          limit: query.limit,
          offset: query.offset,
          hasMore: result.total > query.offset + query.limit,
        },
      };
    } catch (error: any) {
      if (error.message === 'Device not found') {
        throw new NotFoundException('Device not found');
      }
      throw error;
    }
  }

  @Get(':deviceId/stats')
  async getDeviceDataStats(
    @Context() context: RequestContext,
    @Param('deviceId') deviceId: string
  ) {
    try {
      const stats = await this.deviceService.getDeviceDataStats(deviceId, context.userId!);
      return {
        success: true,
        stats,
      };
    } catch (error: any) {
      if (error.message === 'Device not found') {
        throw new NotFoundException('Device not found');
      }
      throw error;
    }
  }
}