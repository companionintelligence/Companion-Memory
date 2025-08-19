import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { IdFormatGuard, JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { LoggerService } from '@ci/common/services';
import { RequestContext } from '@ci/common/types';

import { MemoryService } from '../services/MemoryService';
import { MemorySearchParams } from '../types';

const memorySearchSchema = z.object({
  query: z.string().optional(),
  startDate: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
  endDate: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
  categories: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((val) => {
      if (typeof val === 'string') {
        return [val];
      }

      return val;
    }),
  hasLocation: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (typeof val === 'string') {
        return val === 'true';
      }

      return val;
    }),
  limit: z
    .union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      const num = typeof val === 'string' ? parseInt(val, 10) : val;

      return Math.min(Math.max(1, num || 50), 100);
    }),
  offset: z
    .union([z.number(), z.string()])
    .optional()
    .transform((val) => {
      const num = typeof val === 'string' ? parseInt(val, 10) : val;

      return Math.max(0, num || 0);
    }),
});

@Controller('memory')
@UseGuards(JwtAuthGuard)
export class MemoryController {
  private logger = new LoggerService(MemoryController.name);

  constructor(private readonly memoryService: MemoryService) {}

  @Get()
  async findAll(
    @Context() context: RequestContext,
    @Query(new ValidationPipe(memorySearchSchema)) params: MemorySearchParams,
  ) {
    this.logger.debug('Memory findAll request', {
      userId: context.userId,
      params,
      hasUserId: !!context.userId,
    });

    if (!context.userId) {
      this.logger.warn('No userId in context', { context });
    }

    try {
      const result = await this.memoryService.findAll(context, params);
      this.logger.debug('Memory findAll response', {
        dataLength: result.data.length,
        total: result.total,
      });

      return result;
    } catch (error) {
      this.logger.error('Error in memory findAll', { error, userId: context.userId });
      throw error;
    }
  }

  @Get(':id')
  @UseGuards(IdFormatGuard)
  async findOne(@Context() context: RequestContext, @Param('id') id: string) {
    return this.memoryService.findOne(context, id);
  }

  // Temporary debug endpoint without auth
  // @Get('debug/test')
  async debugTest() {
    this.logger.debug('Debug test endpoint called');

    // Try to get some data directly from the database
    const testContext = { userId: 'b3b8c7e2-1c2d-4e5f-8a6b-9c0d1e2f3a4b' } satisfies RequestContext; // Using the userId from your logs

    try {
      const result = await this.memoryService.findAll(testContext as RequestContext, { limit: 10 });

      // Also check for locations and places
      const debugInfo = await this.memoryService.getDebugInfo(testContext);

      return {
        success: true,
        ...result,
        debug: {
          userId: testContext.userId,
          timestamp: new Date().toISOString(),
          ...debugInfo,
        },
      };
    } catch (error) {
      this.logger.error('Debug test error', { error });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        debug: {
          userId: testContext.userId,
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  // Debug endpoint to check raw events
  // @Get('debug/events')
  async debugEvents() {
    this.logger.debug('Debug events endpoint called');

    try {
      // Get raw event data
      const rawEvents = await this.memoryService.getRawEvents();

      return {
        success: true,
        totalEvents: rawEvents.length,
        events: rawEvents.slice(0, 5), // First 5 events
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Debug events error', { error });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Debug endpoint to get all memories without user filter
  // @Get('debug/all')
  async debugAll() {
    this.logger.debug('Debug all memories endpoint called');

    try {
      // Get memories for all users
      const result = await this.memoryService.findAllDebug();

      return {
        success: true,
        ...result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Debug all error', { error });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Direct database test
  @Get('debug/direct')
  async debugDirect() {
    this.logger.warn('DEBUGGING: Direct database test');

    try {
      const result = await this.memoryService.directDatabaseTest();

      return {
        success: true,
        ...result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Debug direct error', { error });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Test event conversion
  // @Get('debug/test-events')
  async testEventConversion() {
    this.logger.warn('Testing event conversion');

    try {
      const result = await this.memoryService.testEventConversion();

      return {
        success: true,
        ...result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Test event conversion error', { error });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Test location lookup
  // @Get('debug/test-locations')
  async testLocationLookup() {
    this.logger.warn('Testing location lookup');

    try {
      const result = await this.memoryService.testLocationLookup();

      return {
        success: true,
        ...result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Test location lookup error', { error });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }
}
