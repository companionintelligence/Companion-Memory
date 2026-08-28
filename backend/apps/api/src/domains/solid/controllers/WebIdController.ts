import { Controller, Get, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { SYSTEM_USER } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { UserService } from '@ci/domains/user';

import { negotiateRdf } from '../rdf';
import { ProfileDocumentService } from '../services/ProfileDocumentService';
import { WebIdService } from '../services/WebIdService';

import { requestOrigin } from './requestOrigin';

/**
 * Serves WebID Profile Documents — the public identity cards of the Solid
 * facade — at `GET /solid/profile/:userId`, content-negotiated between Turtle
 * and JSON-LD.
 *
 * Deliberately UNAUTHENTICATED: a WebID profile must be world-dereferenceable
 * for federation to work (a relying party fetches it to find the user's OIDC
 * issuer before any token exists). The only gate is the `solid.protocol`
 * feature flag — off by default — so this surface stays dark until explicitly
 * enabled. The document carries only already-public profile facts (name,
 * mailbox, issuer, storage pointer); no secret ever reaches it.
 */
@Controller('solid')
export class WebIdController {
  constructor(
    private readonly features: FeatureService,
    private readonly users: UserService,
    private readonly webIds: WebIdService,
    private readonly profileDocuments: ProfileDocumentService,
  ) {}

  @Get('profile/:userId')
  async getProfile(
    @Param('userId') userId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Flag off => the whole Solid surface 404s, indistinguishable from "no such
    // route", so nothing about the facade is observable until it's turned on.
    if (!(await this.features.isFeatureEnabled('solid.protocol'))) {
      throw new NotFoundException();
    }

    const origin = this.webIds.resolveOrigin(requestOrigin(req));

    // System context: this is a public read of a public document, not the
    // authenticated user reading their own row.
    const user = await this.users.findById({ userId: SYSTEM_USER }, userId);
    if (!user) {
      throw new NotFoundException();
    }

    const quads = this.profileDocuments.build(user, origin);
    const serialization = negotiateRdf(req.headers.accept);

    res.type(serialization.mediaType).send(serialization.serialize(quads));
  }
}
