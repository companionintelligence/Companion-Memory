import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Body,
  UseGuards,
  Param,
  ConflictException,
  BadRequestException,
  HttpStatus,
  HttpCode,
  NotFoundException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { PgErrorCode } from '@ci/common/constants';
import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { PositionService } from '../services/PositionService';
import {
  CreatePositionDto,
  UpdatePositionDto,
  Position,
  createPositionSchema,
  updatePositionSchema,
  Geofence,
  GeofenceRadius,
  GeofencePolygon,
} from '../types';

@Controller('position')
export class PositionController {
  constructor(private readonly positionService: PositionService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post()
  async create(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(createPositionSchema))
    input: CreatePositionDto[],
  ): Promise<Position[]> {
    const serviceContext = toServiceContext(context);

    this.validateContentArray(input);

    try {
      return await this.positionService.create(serviceContext, input);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('One or more position records already exist for this time and user');
      }

      throw error;
    }
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get(':id')
  async findById(@Context() context: RequestContext, @Param('id') id: string) {
    const serviceContext = toServiceContext(context);

    const position = await this.positionService.findById(serviceContext, id);

    if (!position) {
      throw new NotFoundException('Position not found');
    }

    return position;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body(new ValidationPipe(updatePositionSchema)) data: UpdatePositionDto,
  ) {
    const serviceContext = toServiceContext(context);

    const result = await this.positionService.update(serviceContext, id, data);

    if (!result) {
      throw new NotFoundException();
    }

    return result;
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Context() context: RequestContext, @Param('id') positionId: string): Promise<void> {
    const serviceContext = toServiceContext(context);

    const question = await this.positionService.findById(serviceContext, positionId);

    if (!question) {
      throw new NotFoundException('Position not found');
    }

    const removal = this.positionService.remove(serviceContext, positionId);

    if (!removal) {
      throw new NotFoundException();
    }
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('range')
  async findByDateRange(
    @Context() context: RequestContext,
    @Query('start') start: string,
    @Query('end') end: string,
  ): Promise<Position[]> {
    const serviceContext = toServiceContext(context);

    const { startDate, endDate } = this.parseAndValidateDateRange(start, end);

    return this.positionService.findByDateRange(serviceContext, startDate, endDate);
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('geofence')
  async findByGeofence(
    @Context() context: RequestContext,
    @Query('type') type: 'radius' | 'polygon',
    @Query('centerLon') centerLon?: string,
    @Query('centerLat') centerLat?: string,
    @Query('radius') radius?: string,
    @Query('coordinates') coordinates?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ): Promise<Position[]> {
    const serviceContext = toServiceContext(context);

    const geofence = this.parseGeofence(type, centerLon, centerLat, radius, coordinates);
    const { startDate, endDate } = this.parseOptionalDateRange(start, end);

    return this.positionService.findByGeofence(serviceContext, geofence, startDate, endDate);
  }

  private validateContentArray(content?: CreatePositionDto[]): void {
    if (!content || content.length === 0) {
      throw new BadRequestException('Content array must contain at least one location');
    }
  }

  private parseAndValidateDateRange(start: string, end: string): { startDate: Date; endDate: Date } {
    if (!start || !end) {
      throw new BadRequestException('Start and end date parameters are required');
    }

    const startDate = new Date(start);
    const endDate = new Date(end);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid date format. Use ISO 8601 format.');
    }

    if (startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    return { startDate, endDate };
  }

  private parseOptionalDateRange(start?: string, end?: string): { startDate?: Date; endDate?: Date } {
    let startDate: Date | undefined;
    let endDate: Date | undefined;

    if (start) {
      startDate = new Date(start);
      if (isNaN(startDate.getTime())) {
        throw new BadRequestException('Invalid start date format. Use ISO 8601 format.');
      }
    }

    if (end) {
      endDate = new Date(end);
      if (isNaN(endDate.getTime())) {
        throw new BadRequestException('Invalid end date format. Use ISO 8601 format.');
      }
    }

    if (startDate && endDate && startDate > endDate) {
      throw new BadRequestException('Start date must be before end date');
    }

    return { startDate, endDate };
  }

  private parseGeofence(
    type: 'radius' | 'polygon',
    centerLon?: string,
    centerLat?: string,
    radius?: string,
    coordinates?: string,
  ): Geofence {
    if (!type || (type !== 'radius' && type !== 'polygon')) {
      throw new BadRequestException('Geofence type must be either "radius" or "polygon"');
    }

    if (type === 'radius') {
      return this.parseRadiusGeofence(centerLon, centerLat, radius);
    }

    return this.parsePolygonGeofence(coordinates);
  }

  private parseRadiusGeofence(centerLon?: string, centerLat?: string, radius?: string): GeofenceRadius {
    if (!centerLon || !centerLat || !radius) {
      throw new BadRequestException('Radius geofence requires centerLon, centerLat, and radius parameters');
    }

    const lon = parseFloat(centerLon);
    const lat = parseFloat(centerLat);
    const radiusMeters = parseFloat(radius);

    if (isNaN(lon) || isNaN(lat) || isNaN(radiusMeters)) {
      throw new BadRequestException('Invalid numeric values for radius geofence');
    }

    if (radiusMeters <= 0) {
      throw new BadRequestException('Radius must be greater than 0');
    }

    return {
      center: {
        longitude: lon,
        latitude: lat,
      },
      radius_meters: radiusMeters,
    };
  }

  private parsePolygonGeofence(coordinates?: string): GeofencePolygon {
    if (!coordinates) {
      throw new BadRequestException('Polygon geofence requires coordinates parameter (JSON array)');
    }

    let coordsArray: Array<{ longitude: number; latitude: number }>;
    try {
      coordsArray = JSON.parse(coordinates);
    } catch {
      throw new BadRequestException('Invalid JSON format for coordinates');
    }

    if (!Array.isArray(coordsArray) || coordsArray.length < 3) {
      throw new BadRequestException('Coordinates must be an array with at least 3 points');
    }

    const validCoords = coordsArray.every(
      (coord) =>
        typeof coord === 'object' &&
        coord !== null &&
        typeof coord.longitude === 'number' &&
        typeof coord.latitude === 'number' &&
        !isNaN(coord.longitude) &&
        !isNaN(coord.latitude),
    );

    if (!validCoords) {
      throw new BadRequestException('Each coordinate must have valid longitude and latitude numbers');
    }

    return {
      coordinates: coordsArray,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION;
  }
}
