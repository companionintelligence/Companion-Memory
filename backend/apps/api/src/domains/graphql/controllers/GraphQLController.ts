import path from 'node:path';

import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Context, type RequestContext } from '@ci/common/context';

@Controller()
export class GraphQLController {
  constructor() {}

  @Get('graphql')
  async playground(@Context() context: RequestContext, @Res() res: Response) {
    res.sendFile(path.resolve(__dirname, 'playground.html'));
  }
}
