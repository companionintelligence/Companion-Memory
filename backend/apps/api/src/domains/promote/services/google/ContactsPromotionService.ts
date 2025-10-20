import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import { GraphUtilityService, GraphNodeEntity } from '@ci/domains/graph';

import { PersonPromotionService } from '../PersonPromotionService';

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
  private logger = new LoggerService(ContactsPromotionService.name);

  constructor(
    @InjectRepository(GraphNodeEntity)
    private readonly entityRepository: Repository<GraphNodeEntity>,
    private readonly graphUtilityService: GraphUtilityService,
    private readonly personPromotionService: PersonPromotionService,
  ) {}

  async promoteContacts(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Starting Contacts promotion', {
      userId,
      connectionId,
    });

    try {
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
      const userEntityId = await this.personPromotionService.getUserEntityId(userId);

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
    } catch (error) {
      this.logger.error('Error promoting contacts', {
        userId,
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
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
    let existingEntity: GraphNodeEntity | null = null;

    if (primaryEmail) {
      existingEntity = await this.entityRepository
        .createQueryBuilder('entity')
        .where("entity.entity_type = 'Person'")
        .andWhere("entity.properties->>'email' = :email", { email: primaryEmail })
        .andWhere("entity.properties->>'owner_user_id' = :userId", { userId })
        .getOne();
    }

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

      await this.graphUtilityService.createGraphNode({
        entityId: contactEntityId,
        entityType: 'Person',
        name: displayName,
        description: `Contact from Google Contacts`,
        properties,
        searchContent: `${displayName} ${primaryEmail || ''} ${primaryPhone || ''}`,
        ownerUserId: userId,
      });

      this.logger.log('Created new contact entity', {
        contactEntityId,
        name: displayName,
      });
    } else {
      // Update existing entity
      contactEntityId = existingEntity.entity_id;

      const currentProperties = existingEntity.properties as Record<string, unknown>;
      const updatedProperties = {
        ...currentProperties,
        google_contacts_synced: true,
        last_synced_at: new Date().toISOString(),
      };

      existingEntity.properties = updatedProperties;
      await this.entityRepository.save(existingEntity);

      this.logger.log('Updated existing contact entity', {
        contactEntityId,
        name: displayName,
      });
    }

    // Create KNOWS relationship (ensuring every entity has at least one relationship)
    const existingRelationships = await this.graphUtilityService.findConnectedEntities(
      userEntityId,
      ['KNOWS'],
      'outbound',
    );

    const relationshipExists = existingRelationships.some((entity) => entity.entity_id === contactEntityId);

    if (!relationshipExists) {
      await this.graphUtilityService.createRelationship(
        userEntityId,
        contactEntityId,
        'KNOWS',
        {
          source: 'google_contacts',
          connection_id: connectionId,
          synced_at: new Date().toISOString(),
        },
        1.0,
        userId,
      );

      this.logger.log('Created KNOWS relationship', {
        userEntityId,
        contactEntityId,
      });
    }

    // If contact has relations (e.g., spouse, child), create those relationships
    if (contact.relations && contact.relations.length > 0) {
      for (const relation of contact.relations) {
        if (relation.person && relation.type) {
          // Try to find the related person by name
          const relatedPersonName = relation.person;
          const relationType = this.normalizeRelationType(relation.type);

          if (relationType) {
            // Note: In a real implementation, you'd search for the person by name
            // For now, we just log it
            this.logger.log('Contact has relationship', {
              contactName: displayName,
              relatedPerson: relatedPersonName,
              relationType,
            });
          }
        }
      }
    }

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
