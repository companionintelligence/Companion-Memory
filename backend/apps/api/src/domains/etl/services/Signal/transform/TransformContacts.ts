import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { PeoplePromotionService } from '@ci/domains/people';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';
import type { SignalContact } from '../sync/signalApi';

@Injectable()
export class SignalContactsTransformService {
  constructor(
    private readonly peoplePromotionService: PeoplePromotionService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SignalContactsTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;
    const contacts = (data?.contacts as SignalContact[]) || [];

    this.logger.log('Starting Signal contacts transformation', {
      userId,
      connectionId: connection.id,
    });

    if (contacts.length === 0) {
      return;
    }

    const context = toServiceContext({ userId });
    const { userNode } = await this.promoteService.getUserAndEntity(context, userId);

    for (const contact of contacts) {
      const contactNumber = contact.number || contact.uuid;

      if (!contactNumber) {
        continue;
      }

      const displayName =
        contact.name ||
        [contact.given_name, contact.family_name].filter(Boolean).join(' ') ||
        contact.nickname ||
        contactNumber;

      // Promotion replaces the property-scan find-or-create: the profile
      // upserts on (signal, number-or-uuid), a real phone number becomes a
      // strong identifier (so a Signal contact chains into the same Person a
      // Google contact with that number resolved to), and a uuid-only contact
      // still gets a stable profile.
      await this.peoplePromotionService.observeProfile(context, {
        sourceSystem: 'signal',
        remoteKey: contactNumber,
        displayName,
        handle: contact.nickname ?? null,
        phones: contact.number ? [contact.number] : [],
        properties: {
          signal_number: contactNumber,
          connection_id: connection.id,
          sources: ['signal'],
        },
      });

      this.logger.debug('Processed Signal contact', {
        contactNumber,
        userNodeId: userNode.entityId,
      });
    }

    this.logger.log('Signal contacts transformation completed', {
      userId,
      connectionId: connection.id,
      totalContacts: contacts.length,
    });
  }
}
