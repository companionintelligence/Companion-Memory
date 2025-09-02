import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { z } from 'zod';

import { PgErrorCode } from '@ci/common/constants';
import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';
import { UserService } from '@ci/domains/user/services/UserService';

const updateProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  email: z.string().email('Invalid email address').optional(),
});

@Controller('mobile/user')
@UseGuards(JwtAuthGuard)
export class MobileUserController {
  constructor(private readonly userService: UserService) {}

  @Get('profile')
  async getProfile(@Context() context: RequestContext) {
    const userId = context.userId;

    if (userId == null) {
      throw new NotFoundException('User not found');
    }

    const user = await this.userService.findOne(userId);

    if (user == null) {
      throw new NotFoundException('User not found');
    }

    return {
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    };
  }

  @Patch('profile')
  async updateProfile(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(updateProfileSchema)) input: { name?: string; email?: string },
  ) {
    const userId = context.userId;

    if (userId == null) {
      throw new NotFoundException('User not found');
    }

    try {
      const updatedUser = await this.userService.update(userId, input);

      if (updatedUser == null) {
        throw new NotFoundException('User not found');
      }

      return {
        success: true,
        data: {
          id: updatedUser.id,
          name: updatedUser.name,
          email: updatedUser.email,
        },
        message: 'Profile updated successfully',
      };
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === PgErrorCode.UNIQUE_VIOLATION) {
        throw new ConflictException('Email already exists');
      }

      throw error;
    }
  }

  @Get('preferences')
  async getPreferences(@Context() context: RequestContext) {
    const userId = context.userId;

    if (userId == null) {
      throw new NotFoundException('User not found');
    }

    // For now, return basic mobile preferences
    // This could be extended to include actual user preferences from database
    return {
      success: true,
      data: {
        notifications: {
          enabled: true,
          sound: true,
          vibration: true,
        },
        theme: 'auto', // auto, light, dark
        language: 'en',
      },
    };
  }

  @Patch('preferences')
  async updatePreferences(
    @Context() context: RequestContext,
    @Body() preferences: any,
  ) {
    const userId = context.userId;

    if (userId == null) {
      throw new NotFoundException('User not found');
    }

    // In a real implementation, you would save preferences to database
    // For now, just return success
    return {
      success: true,
      data: preferences,
      message: 'Preferences updated successfully',
    };
  }
}