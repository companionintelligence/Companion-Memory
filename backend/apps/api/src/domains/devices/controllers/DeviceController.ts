import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  ConflictException,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { PgErrorCode } from '@ci/common/constants';
import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { DeviceService } from '../services/DeviceService';
import { CreateDeviceDto, UpdateDeviceDto, Device, createDeviceSchema, updateDeviceSchema } from '../types';

@Controller('devices')
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createDeviceSchema)) input: CreateDeviceDto | CreateDeviceDto[],
  ): Promise<Device | Device[]> {
    const serviceContext = toServiceContext(context);

    try {
      return await this.deviceService.create(serviceContext, input);
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        throw new ConflictException('Device record already exists');
      }

      throw error;
    }
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get()
  async findAll(@Context() context: RequestContext): Promise<Device[]> {
    const serviceContext = toServiceContext(context);

    return this.deviceService.findAll(serviceContext);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get(':id')
  async findOne(@Context() context: RequestContext, @Param('id') deviceId: string): Promise<Device | null> {
    const serviceContext = toServiceContext(context);

    const device = await this.deviceService.findById(serviceContext, deviceId);
    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return device;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') deviceId: string,
    @Body(new ValidationPipe(updateDeviceSchema)) data: UpdateDeviceDto,
  ): Promise<Device | null> {
    const serviceContext = toServiceContext(context);

    const device = await this.deviceService.update(serviceContext, deviceId, data);

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return device;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Context() context: RequestContext, @Param('id') deviceId: string): Promise<void> {
    const serviceContext = toServiceContext(context);

    const device = await this.deviceService.findById(serviceContext, deviceId);

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    const removal = this.deviceService.remove(serviceContext, deviceId);

    if (!removal) {
      throw new NotFoundException();
    }
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Patch(':id/primary')
  async setPrimary(
    @Context() context: RequestContext,
    @Param('id') deviceId: string,
  ): Promise<Device | null> {
    const serviceContext = toServiceContext(context);

    const device = await this.deviceService.setPrimary(serviceContext, deviceId);
    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return device;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Patch(':id/last-seen')
  async updateLastSeen(
    @Context() context: RequestContext,
    @Param('id') deviceId: string,
  ): Promise<Device | null> {
    const serviceContext = toServiceContext(context);

    const device = await this.deviceService.updateLastSeen(serviceContext, deviceId);
    if (!device) {
      throw new NotFoundException('Device not found');
    }

    return device;
  }
}
