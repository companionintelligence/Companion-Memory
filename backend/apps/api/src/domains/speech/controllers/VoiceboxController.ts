import {
  Controller,
  Post,
  Get,
  Delete,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  Body,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import FormData from 'form-data';

import { Context, type RequestContext } from '@ci/common/context';
import { JwtAuthGuard } from '@ci/common/guards';
import { ProxyService } from '@ci/common/services/ProxyService';
import config from '@ci/configuration';

import type { VoiceProfileCreateRequest, VoiceSynthesizeRequest } from '../types';

@Controller('voicebox')
export class VoiceboxController {
  constructor(private readonly proxyService: ProxyService) {}

  @UseGuards(JwtAuthGuard)
  @Post('profile/create')
  async createProfile(
    @Context() context: RequestContext,
    @Body() body: VoiceProfileCreateRequest,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (context.userId == null) {
      throw new UnauthorizedException();
    }

    if (!config.services.voicebox.enabled) {
      return res.status(503).json({
        error: 'Voicebox service is not enabled',
        message: 'Set VOICEBOX_ENABLED=true in environment to enable voice cloning',
      });
    }

    return await this.proxyService.proxyRequest(
      req,
      res,
      `${config.services.voicebox.host}/voicebox/profile/create`,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('sample/upload')
  @UseInterceptors(FileInterceptor('audio_file'))
  async uploadSample(
    @Context() context: RequestContext,
    @Body('profile_id') profileId: string,
    @UploadedFile() file: Express.Multer.File,
    @Res() res: Response,
  ) {
    if (context.userId == null) {
      throw new UnauthorizedException();
    }

    if (!config.services.voicebox.enabled) {
      return res.status(503).json({
        error: 'Voicebox service is not enabled',
        message: 'Set VOICEBOX_ENABLED=true in environment to enable voice cloning',
      });
    }

    if (!file) {
      throw new BadRequestException('No audio file provided');
    }

    if (!profileId) {
      throw new BadRequestException('No profile_id provided');
    }

    // Create FormData to forward to voicebox service
    const formData = new FormData();
    formData.append('profile_id', profileId);
    formData.append('audio_file', file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });

    try {
      const response = await fetch(`${config.services.voicebox.host}/voicebox/sample/upload`, {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders(),
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (error) {
      throw new BadRequestException(`Failed to upload sample: ${error.message}`);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('voices')
  async listVoices(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (context.userId == null) {
      throw new UnauthorizedException();
    }

    if (!config.services.voicebox.enabled) {
      return res.status(503).json({
        error: 'Voicebox service is not enabled',
        message: 'Set VOICEBOX_ENABLED=true in environment to enable voice cloning',
      });
    }

    return await this.proxyService.proxyRequest(
      req,
      res,
      `${config.services.voicebox.host}/voicebox/voices`,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('synthesize')
  async synthesize(
    @Context() context: RequestContext,
    @Body() body: VoiceSynthesizeRequest,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (context.userId == null) {
      throw new UnauthorizedException();
    }

    if (!config.services.voicebox.enabled) {
      return res.status(503).json({
        error: 'Voicebox service is not enabled',
        message: 'Set VOICEBOX_ENABLED=true in environment to enable voice cloning',
      });
    }

    return await this.proxyService.proxyRequest(
      req,
      res,
      `${config.services.voicebox.host}/voicebox/synthesize`,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('profile/:profile_id')
  async deleteProfile(
    @Context() context: RequestContext,
    @Param('profile_id') profileId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (context.userId == null) {
      throw new UnauthorizedException();
    }

    if (!config.services.voicebox.enabled) {
      return res.status(503).json({
        error: 'Voicebox service is not enabled',
        message: 'Set VOICEBOX_ENABLED=true in environment to enable voice cloning',
      });
    }

    return await this.proxyService.proxyRequest(
      req,
      res,
      `${config.services.voicebox.host}/voicebox/profile/${profileId}`,
    );
  }
}
