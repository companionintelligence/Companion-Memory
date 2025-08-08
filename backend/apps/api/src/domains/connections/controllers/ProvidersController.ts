import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '@ci/common/guards';

import { ProviderService } from '../services/ProviderService';

@Controller('providers')
export class ProvidersController {
  constructor(private readonly providerService: ProviderService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll() {
    return this.providerService.findAll();
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.providerService.findOne(id);
  }
}
