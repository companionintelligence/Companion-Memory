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

  /**
   * Aggregate counts for the location settings UI.
   *
   * `stats`, `range` and `geofence` are declared BEFORE the ':id' route.
   * Express matches in declaration order, so a static segment declared after
   * ':id' is captured by it, and the global IdFormatGuard then answers 404
   * because 'range' is not a UUID.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('stats')
  async stats(@Context() context: RequestContext) {
    const serviceContext = toServiceContext(context);

    return this.positionService.getStats(serviceContext);
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

    // Awaited so that a 204 means the row is gone. Unawaited, a failed delete
    // still answered 204, and the check below tested a Promise, which is always
    // truthy. remove() does its own lookup and answers false when nothing matched.
    const removed = await this.positionService.remove(serviceContext, positionId);

    if (!removed) {
      throw new NotFoundException('Position not found');
    }
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

    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(radiusMeters)) {
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
        // isFinite, not !isNaN: JSON.parse turns 1e999 into Infinity, which
        // would reach ST_GeogFromText as "Infinity" and answer 500.
        Number.isFinite(coord.longitude) &&
        Number.isFinite(coord.latitude),
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
