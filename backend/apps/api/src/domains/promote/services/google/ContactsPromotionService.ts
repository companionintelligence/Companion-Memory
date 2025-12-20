import { Injectable } from '@nestjs/common';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { PersonService, PersonEntity } from '@ci/domains/memory';

import { PromoteService } from '../PromoteService';

interface PropsToCheck {
  owner_user_id: string;
  email?: string;
  phone?: string;
}

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
export class ContactsPromotionService {
  constructor(
    private readonly personService: PersonService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ContactsPromotionService.name);
  }

  async promoteContacts(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Starting Contacts promotion', {
      userId,
      connectionId,
    });

    const contacts = this.extractContacts(apiLogContent);

    if (contacts.length === 0) {
      this.logger.log('No contacts found to promote', { userId, connectionId });

      return;
    }

    this.logger.log(`Processing ${contacts.length} contacts`, {
      userId,
      connectionId,
      contactCount: contacts.length,
    });

    // Get user's entity ID (create if missing)
    const { userNode } = await this.promoteService.getUserAndEntity({ userId }, userId);

    const userEntityId = userNode.entityId;

    for (const contact of contacts) {
      try {
        await this.processContact(contact, userId, userEntityId, connectionId);
      } catch (error) {
        this.logger.error('Error processing contact', {
          contact: contact.names?.[0]?.displayName,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Contacts promotion completed', {
      userId,
      connectionId,
      processedCount: contacts.length,
    });
  }

  private extractContacts(content: unknown): GoogleContact[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;

    if ('contacts' in contentObj && Array.isArray(contentObj.contacts)) {
      return contentObj.contacts as GoogleContact[];
    }

    return [];
  }

  private async processContact(
    contact: GoogleContact,
    userId: string,
    userEntityId: string,
    connectionId: string,
  ): Promise<void> {
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

    // Check if contact entity already exists by email or phone
    let existingEntity: PersonEntity | null = null;

    const propsToCheck: PropsToCheck = {
      owner_user_id: userId,
    };
    if (primaryEmail) {
      propsToCheck.email = primaryEmail;
    }

    if (primaryPhone) {
      propsToCheck.phone = primaryPhone;
    }

    const existingEntities = await this.personService.search(
      { userId },
      {
        properties: { ...propsToCheck },
      },
    );
    existingEntity = existingEntities.length > 0 ? existingEntities[0] : null;

    let contactEntityId: string;

    if (!existingEntity) {
      // Create new contact entity
      contactEntityId = uuid7();

      const properties: Record<string, unknown> = {
        email: primaryEmail,
        phone: primaryPhone,
        first_name: givenName,
        last_name: familyName,
        source: 'google_contacts',
        connection_id: connectionId,
        owner_user_id: userId,
      };

      // Add all email addresses
      if (contact.emailAddresses && contact.emailAddresses.length > 0) {
        properties.emails = contact.emailAddresses.map((e) => ({
          value: e.value,
          type: e.type,
        }));
      }

      // Add all phone numbers
      if (contact.phoneNumbers && contact.phoneNumbers.length > 0) {
        properties.phones = contact.phoneNumbers.map((p) => ({
          value: p.value,
          type: p.type,
        }));
      }

      // Add addresses
      if (contact.addresses && contact.addresses.length > 0) {
        properties.addresses = contact.addresses.map((a) => ({
          value: a.formattedValue,
          type: a.type,
        }));
      }

      // Add organization info
      if (contact.organizations && contact.organizations.length > 0) {
        properties.organization = contact.organizations[0].name;
        properties.job_title = contact.organizations[0].title;
      }

      // Add occupation
      if (contact.occupations && contact.occupations.length > 0) {
        properties.occupation = contact.occupations[0].value;
      }

      // Add birthday
      if (contact.birthdays && contact.birthdays.length > 0 && contact.birthdays[0].date) {
        const birthday = contact.birthdays[0].date;
        properties.birthday = `${birthday.year || ''}${birthday.month || ''}${birthday.day || ''}`;
      }

      // Add photo
      if (contact.photos && contact.photos.length > 0) {
        properties.photo_url = contact.photos[0].url;
      }

      await this.personService.create(
        { userId },
        {
          id: contactEntityId,
          name: displayName,
          description: `Contact from Google Contacts`,
          properties,
        },
      );

      this.logger.log('Created new contact entity', {
        contactEntityId,
        name: displayName,
      });
    } else {
      // Update existing entity
      contactEntityId = existingEntity.id;

      const currentProperties = (existingEntity.properties as Record<string, unknown>) ?? {};
      const updatedProperties = {
        ...currentProperties,
        google_contacts_synced: true,
        last_synced_at: new Date().toISOString(),
      };

      existingEntity.properties = updatedProperties;
      await this.personService.update({ userId }, existingEntity.id, {
        properties: updatedProperties,
      });

      this.logger.log('Updated existing contact entity', {
        contactEntityId,
        name: displayName,
      });
    }

    // Create KNOWS relationship (ensuring every entity has at least one relationship)
    // FIXME: This should be re-implemented after we create a RelationshipService
    // const existingRelationships = await this.graphUtilityService.findConnectedEntities(
    //   userEntityId,
    //   ['KNOWS'],
    //   'outbound',
    // );

    // const relationshipExists = existingRelationships.some((entity) => entity.entity_id === contactEntityId);

    // if (!relationshipExists) {
    //   await this.personService.createRelationship(
    //     userEntityId,
    //     contactEntityId,
    //     'KNOWS',
    //     {
    //       source: 'google_contacts',
    //       connection_id: connectionId,
    //       synced_at: new Date().toISOString(),
    //     },
    //     1.0,
    //     userId,
    //   );
    //
    //   this.logger.log('Created KNOWS relationship', {
    //     userEntityId,
    //     contactEntityId,
    //   });
    // }

    // If contact has relations (e.g., spouse, child), create those relationships
    // if (contact.relations && contact.relations.length > 0) {
    //   for (const relation of contact.relations) {
    //     if (relation.person && relation.type) {
    //       // Try to find the related person by name
    //       const relatedPersonName = relation.person;
    //       const relationType = this.normalizeRelationType(relation.type);
    //
    //       if (relationType) {
    //         // Note: In a real implementation, you'd search for the person by name
    //         // For now, we just log it
    //         this.logger.log('Contact has relationship', {
    //           contactName: displayName,
    //           relatedPerson: relatedPersonName,
    //           relationType,
    //         });
    //       }
    //     }
    //   }
    // }

    this.logger.log('Processed contact', {
      contactEntityId,
      name: displayName,
    });
  }

  private normalizeRelationType(type: string): string | null {
    const relationshipMap: Record<string, string> = {
      spouse: 'SPOUSE',
      child: 'PARENT_OF',
      mother: 'CHILD_OF',
      father: 'CHILD_OF',
      parent: 'CHILD_OF',
      brother: 'SIBLING_OF',
      sister: 'SIBLING_OF',
      friend: 'KNOWS',
      relative: 'FAMILY_MEMBER',
      partner: 'SPOUSE',
      manager: 'WORKS_WITH',
      assistant: 'WORKS_WITH',
      referred_by: 'KNOWS',
    };

    return relationshipMap[type.toLowerCase()] || null;
  }
}
