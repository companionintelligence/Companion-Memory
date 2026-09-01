import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { PersonService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';
import type { SignalContact } from '../sync/signalApi';

@Injectable()
export class SignalContactsTransformService {
  constructor(
    private readonly personService: PersonService,
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

      const existingPeople = await this.personService.search(context, {
        properties: {
          owner_user_id: userId,
          signal_number: contactNumber,
        },
      });

      if (existingPeople.length === 0) {
        await this.personService.create(context, {
          id: uuidv7(),
          name: displayName,
          description: `Signal contact ${displayName}`,
          properties: {
            signal_number: contactNumber,
            ...(contact.uuid && contact.uuid !== contactNumber ? { signal_uuid: contact.uuid } : {}),
            owner_user_id: userId,
            connection_id: connection.id,
            sources: ['signal'],
          },
        });
      }

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
