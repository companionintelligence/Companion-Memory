import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import type { RequestContext } from '@ci/common/types';

import type { CreateDeviceDto, UpdateDeviceDto, DeviceType } from '../types';
import { DeviceService } from '../services/DeviceService';

const createDeviceSchema = z.object({
  name: z.string().min(1, 'Device name is required'),
  type: z.enum([
    'quest3',
    'xreal-ultra',
    'xreal-one',
    'xreal-one-pro',
    'xreal-air-2',
    'ios',
    'android',
    'windows-app',
    'mac-app',
    'sipeed-maixcam',
    'sipeed-maixcam-pro',
    'omi-pendant',
    'omi-glasses',
  ]),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
});

const updateDeviceSchema = z.object({
  name: z.string().min(1, 'Device name is required').optional(),
  type: z.enum([
    'quest3',
    'xreal-ultra',
    'xreal-one',
    'xreal-one-pro',
    'xreal-air-2',
    'ios',
    'android',
    'windows-app',
    'mac-app',
    'sipeed-maixcam',
    'sipeed-maixcam-pro',
    'omi-pendant',
    'omi-glasses',
  ]).optional(),
  status: z.enum(['connected', 'disconnected', 'authorized', 'unauthorized']).optional(),
  lastSeen: z.date().optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
});

@Controller('devices')
@UseGuards(JwtAuthGuard)
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  @Get()
  async findAll(@Context() ctx: RequestContext) {
    return this.deviceService.findAll(ctx.user.id);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Context() ctx: RequestContext) {
    return this.deviceService.findOne(id, ctx.user.id);
  }

  @Post()
  async create(
    @Body(new ValidationPipe(createDeviceSchema)) createDeviceDto: CreateDeviceDto,
    @Context() ctx: RequestContext,
  ) {
    return this.deviceService.create(createDeviceDto, ctx.user.id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ValidationPipe(updateDeviceSchema)) updateDeviceDto: UpdateDeviceDto,
    @Context() ctx: RequestContext,
  ) {
    return this.deviceService.update(id, updateDeviceDto, ctx.user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Context() ctx: RequestContext) {
    return this.deviceService.remove(id, ctx.user.id);
  }

  @Post(':id/heartbeat')
  @HttpCode(HttpStatus.NO_CONTENT)
  async heartbeat(@Param('id') id: string, @Context() ctx: RequestContext) {
    return this.deviceService.updateLastSeen(id, ctx.user.id);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: 'connected' | 'disconnected' | 'authorized' | 'unauthorized' },
    @Context() ctx: RequestContext,
  ) {
    return this.deviceService.updateStatus(id, body.status, ctx.user.id);
  }
}