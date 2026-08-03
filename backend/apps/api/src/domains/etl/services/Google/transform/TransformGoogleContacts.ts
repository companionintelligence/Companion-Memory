import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { RelationshipService } from '@ci/domains/graph';
import { PeoplePromotionService } from '@ci/domains/people';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';

interface GoogleContact {
  resourceName?: string;
  names?: Array<{
    displayName?: string;
    familyName?: string;
    givenName?: string;
  }>;
  emailAddresses?: Array<{
    value?: string;
    type?: string;
  }>;
  phoneNumbers?: Array<{
    value?: string;
    type?: string;
  }>;
  addresses?: Array<{
    formattedValue?: string;
    type?: string;
  }>;
  organizations?: Array<{
    name?: string;
    title?: string;
  }>;
  occupations?: Array<{
    value?: string;
  }>;
  relations?: Array<{
    person?: string;
    type?: string;
  }>;
  birthdays?: Array<{
    date?: {
      year?: number;
      month?: number;
      day?: number;
    };
  }>;
  photos?: Array<{
    url?: string;
  }>;
}

@Injectable()
export class GoogleContactsTransformService {
  constructor(
    private readonly peoplePromotionService: PeoplePromotionService,
    private readonly connectionService: ConnectionService,
    private readonly promoteService: PromoteService,
    private readonly relationshipService: RelationshipService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GoogleContactsTransformService.name);
  }

  async transformGoogleContacts({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting Google Contacts transformation', {
        userId,
        syncJobId,
      });

      const contacts = this.extractContacts(data);

      if (contacts.length === 0) {
        this.logger.log('No contacts found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${contacts.length} contacts`, {
        userId,
        syncJobId,
        contactCount: contacts.length,
      });

      // Get user's entity ID (create if missing)
      const { userNode } = await this.promoteService.getUserAndEntity({ userId }, userId);
      const userEntityId = userNode.entityId;

      await Promise.all(
        contacts.map(
          async (contact) =>
            await this.processContact({
              contact,
              connectionId: connection.id,
              userId,
              userEntityId,
            }),
        ),
      );

      this.logger.log('Google Contacts transformation completed', {
        userId,
        syncJobId,
        processedCount: contacts.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming Google Contacts', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractContacts(data: unknown): GoogleContact[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for contacts', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from Google People API
    if ('contacts' in dataObj && Array.isArray(dataObj.contacts)) {
      return dataObj.contacts as GoogleContact[];
    }

    if ('connections' in dataObj && Array.isArray(dataObj.connections)) {
      return dataObj.connections as GoogleContact[];
    }

    if ('resourceName' in dataObj && ('names' in dataObj || 'emailAddresses' in dataObj)) {
      return [dataObj as GoogleContact];
    }

    this.logger.warn('No contacts found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private async processContact({
    contact,
    userId,
    userEntityId,
    connectionId,
  }: {
    contact: GoogleContact;
    userId: string;
    userEntityId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      // Extract contact details
      const displayName =
        contact.names?.[0]?.displayName ||
        contact.emailAddresses?.[0]?.value ||
        contact.phoneNumbers?.[0]?.value ||
        'Unknown Contact';

      const givenName = contact.names?.[0]?.givenName || null;
      const familyName = contact.names?.[0]?.familyName || null;
      const primaryEmail = contact.emailAddresses?.[0]?.value || null;
      const primaryPhone = contact.phoneNumbers?.[0]?.value || null;

      this.logger.log('Processing Google Contact', {
        name: displayName,
        email: primaryEmail,
        phone: primaryPhone,
      });

      // Identifier arrays as string[] — the canonical contract shape the
      // identifier index reads (the old writer stored Google's {value, type}
      // objects, which the index could never resolve).
      const emails = (contact.emailAddresses ?? [])
        .map((e) => e.value)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      const phones = (contact.phoneNumbers ?? [])
        .map((p) => p.value)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);

      const properties: Record<string, unknown> = {
        first_name: givenName,
        last_name: familyName,
        source: 'google_contacts',
        connection_id: connectionId,
        google_contacts_synced: true,
        last_synced_at: new Date().toISOString(),
      };

      if (contact.addresses && contact.addresses.length > 0) {
        properties.addresses = contact.addresses.map((a) => ({
          value: a.formattedValue,
          type: a.type,
        }));
      }

      if (contact.organizations && contact.organizations.length > 0) {
        properties.organization = contact.organizations[0].name;
        properties.job_title = contact.organizations[0].title;
      }

      if (contact.occupations && contact.occupations.length > 0) {
        properties.occupation = contact.occupations[0].value;
      }

      if (contact.birthdays && contact.birthdays.length > 0 && contact.birthdays[0].date) {
        const birthday = contact.birthdays[0].date;
        properties.birthday = `${birthday.year || ''}${birthday.month || ''}${birthday.day || ''}`;
      }

      if (contact.photos && contact.photos.length > 0) {
        properties.photo_url = contact.photos[0].url;
      }

      // One promotion call replaces the old search/create/update fork: the
      // profile upserts on (google:contacts, resourceName), identifiers index,
      // and the contact resolves to (or creates / chains into) its Person.
      const observed = await this.peoplePromotionService.observeProfile(
        { userId },
        {
          sourceSystem: 'google:contacts',
          remoteKey: contact.resourceName ?? `name:${displayName}`,
          displayName,
          avatarUrl: contact.photos?.[0]?.url ?? null,
          emails,
          phones,
          properties,
        },
      );
      const contactEntityId = observed.personEntityId;

      this.logger.log(observed.created ? 'Created new contact entity' : 'Resolved contact entity', {
        contactEntityId,
        name: displayName,
        merged: observed.mergedEntityIds.length,
      });

      // Create KNOWS relationship (ensuring every entity has at least one relationship)
      const context = toServiceContext({ userId });
      await this.relationshipService.upsert(context, {
        fromNodeId: userEntityId,
        fromNodeType: 'person',
        toNodeId: contactEntityId,
        toNodeType: 'person',
        type: 'KNOWS',
        properties: {
          source: 'google_contacts',
          connection_id: connectionId,
          synced_at: new Date().toISOString(),
        },
      });

      this.logger.log('Google Contact saved successfully', {
        contactEntityId,
        name: displayName,
      });
    } catch (error) {
      this.logger.error('Error processing individual Google Contact', {
        userId,
        connectionId,
        contactName: contact.names?.[0]?.displayName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other contacts
    }
  }
}
