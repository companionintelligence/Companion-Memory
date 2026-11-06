import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { toServiceContext, type UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ConnectionEntity } from '@ci/domains/connections';
import { EventService } from '@ci/domains/events';
import { type CreateRelationshipDto, NodeService, RelationshipService } from '@ci/domains/graph';
import { Person, PersonService } from '@ci/domains/memory';
import { UserService } from '@ci/domains/user';

export interface ParticipantInfo {
  email: string;
  name: string;
  type?: string; // 'organizer', 'attendee', 'from', 'to', 'cc', 'bcc'
  responseStatus?: string;
}

export type ParticipantSource = 'calendar' | 'email' | 'drive';

export type ParticipantRelationship =
  'MET_WITH' | 'EMAILED' | 'RECEIVED_EMAIL_FROM' | 'ORGANIZED_EVENT_WITH' | 'EDITED_WITH';

/**
 * One set of participants that share a relationship to the owner: a message's
 * From line, its To line, a meeting's organizers. A transform hands over every
 * group of a whole sync page at once (see {@link PromoteService.promoteParticipantGroups}).
 */
export interface ParticipantGroup {
  participants: ParticipantInfo[];
  relationshipType: ParticipantRelationship;
  startDate?: Date;
  endDate?: Date;
}

@Injectable()
export class PromoteService {
  constructor(
    @InjectRepository(ConnectionEntity)
    private readonly connectionRepository: Repository<ConnectionEntity>,
    private readonly eventService: EventService,
    private readonly personService: PersonService,
    private readonly userService: UserService,
    private readonly nodeService: NodeService,
    private readonly relationshipService: RelationshipService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PromoteService.name);
  }

  /**
   * Resolve every participant of a sync page to a Person and link each one to
   * the owner, with a constant number of round trips for the whole page.
   *
   * Returns the Person ids per group, aligned with `groups` and, within a
   * group, with its `participants` — so a transform can read a message's From
   * id and To ids straight back out.
   *
   * ## Why a page at a time
   *
   * The Gmail and Outlook transforms used to call {@link processParticipants}
   * four times per message (from / to / cc / bcc) while processing every
   * message of the page in parallel. Each call fetched the owner's user row and
   * graph node, searched `ci.entities` once per participant, created misses one
   * at a time, and wrote each edge with two endpoint SELECTs, a `save()` and a
   * catch-23505 read-back: fifteen to twenty-five round trips per message, and
   * two messages naming the same new contact in one page raced their searches
   * and minted that contact twice (nothing is unique on an email).
   *
   * This is one owner lookup, one `findByEmails` for the page's distinct
   * addresses, one `create` per address the appliance has never seen, and one
   * multi-row relationship insert. The within-page race is gone by
   * construction: an address is resolved once and the result shared.
   */
  async promoteParticipantGroups(
    context: UserServiceContext,
    {
      connectionId,
      source,
      groups,
    }: {
      connectionId: string;
      source: ParticipantSource;
      groups: ParticipantGroup[];
    },
  ): Promise<string[][]> {
    if (groups.every((group) => group.participants.length === 0)) {
      return groups.map(() => []);
    }

    const { user, userNode } = await this.getUserAndEntity(context, context.userId);
    const people = await this.resolvePeople(context, {
      connectionId,
      source,
      participants: groups.flatMap((group) => group.participants),
      user,
      userNode,
    });

    const edges: CreateRelationshipDto[] = [];
    const ids = groups.map((group) => {
      const entities = group.participants.map((participant) => people.get(participant.email.toLowerCase())!);

      for (const entity of entities) {
        // The owner is a participant like any other for the id list, but
        // never an edge to themselves.
        if (entity.id === userNode.entityId) {
          continue;
        }

        edges.push({
          fromNodeId: userNode.entityId,
          fromNodeType: 'person',
          toNodeId: entity.id,
          toNodeType: 'person',
          type: group.relationshipType,
          startDate: group.startDate,
          endDate: group.endDate,
          properties: {
            source,
            connection_id: connectionId,
            participant_type: (entity.properties?.type as string) ?? null,
            last_interaction: new Date().toISOString(),
          },
        });
      }

      return entities.map((entity) => entity.id);
    });

    try {
      await this.relationshipService.createMany(context, edges);
    } catch (err) {
      // As the per-row path did: the people are resolved and the message will
      // still be written against them; a failed edge is logged, not fatal.
      this.logger.error('Error creating relationships', {
        error: err instanceof Error ? err.message : 'Unknown error',
        userId: context.userId,
        edges: edges.length,
      });
    }

    return ids;
  }

  /**
   * Transforms a list of participant data into a list of Person entity ids. The
   * entity ids will correspond either to previously created Person entities
   * retrieved by email address or new Person entities created from the provided
   * participant data.
   *
   * Note that the returned list of entities can contain the user's
   * corresponding Person entity. For the purposes of building relationships
   * this method will return the list of entity ids and a filtered list
   * excluding the user's Person entity.
   *
   * @param context
   * @param participants
   */
  async upsertPeopleFromParticipants(
    context: UserServiceContext,
    {
      connectionId,
      source,
      participants,
    }: {
      connectionId: string;
      source: string;
      participants: ParticipantInfo[];
    },
  ) {
    const { user, userNode } = await this.getUserAndEntity(context, context.userId);
    const people = await this.resolvePeople(context, { connectionId, source, participants, user, userNode });

    const entities = participants.map((participant) => people.get(participant.email.toLowerCase())!);
    const relationships = entities.map((entity) => (entity.id === userNode.entityId ? null : entity));

    return {
      entities,
      relationships,
    };
  }

  /**
   * One Person per distinct (lower-cased) address: the owner's own node for
   * their address, an existing Person for an address the appliance has seen,
   * a new one otherwise. The first participant to carry an address names it.
   */
  private async resolvePeople(
    context: UserServiceContext,
    {
      connectionId,
      source,
      participants,
      user,
      userNode,
    }: {
      connectionId: string;
      source: string;
      participants: ParticipantInfo[];
      user: NonNullable<Awaited<ReturnType<UserService['findById']>>>;
      userNode: NonNullable<Awaited<ReturnType<NodeService['findNodeByUserId']>>>;
    },
  ): Promise<Map<string, Person>> {
    const firstSighting = new Map<string, ParticipantInfo>();

    for (const participant of participants) {
      const email = participant.email.toLowerCase();

      if (!firstSighting.has(email)) {
        firstSighting.set(email, participant);
      }
    }

    const resolved = new Map<string, Person>();
    const ownerEmail = user.email.toLowerCase();

    if (firstSighting.has(ownerEmail)) {
      const self = await this.personService.findById(context, userNode.entityId);

      if (self == null) {
        throw new Error('User graph node could not be obtained');
      }

      resolved.set(ownerEmail, self);
    }

    const toLookUp = [...firstSighting.keys()].filter((email) => email !== ownerEmail);

    for (const person of await this.personService.findByEmails(context, toLookUp)) {
      const email = person.email?.toLowerCase();

      // Oldest row wins (findByEmails orders by id), as `search(...)[0]` did.
      if (email != null && firstSighting.has(email) && !resolved.has(email)) {
        resolved.set(email, person);
      }
    }

    // Misses are created one at a time through create(), not createMany: the
    // single-row path emits PersonCreatedEvent, which is what indexes a new
    // contact for search. They are the rare case — a page of mail is mostly
    // addresses the appliance already knows.
    for (const email of toLookUp) {
      if (!resolved.has(email)) {
        resolved.set(
          email,
          await this.createPerson(context, firstSighting.get(email)!, email, connectionId, source),
        );
      }
    }

    return resolved;
  }

  private async createPerson(
    context: UserServiceContext,
    participant: ParticipantInfo,
    email: string,
    connectionId: string,
    source: string,
  ): Promise<Person> {
    const id = uuid7();
    const [firstName, ...restName] = participant.name.trim().split(/\s+/).filter(Boolean);
    const lastName = restName.length > 0 ? restName.join(' ') : null;

    const properties: Record<string, unknown> = {
      email,
      first_name: firstName || participant.name,
      last_name: lastName,
      contact_type: source,
      owner_user_id: context.userId,
      connection_id: connectionId,
    };

    return this.personService.create(context, {
      id,
      name: participant.name,
      description: `Contact from ${source}`,
      properties,
    });
  }

  /**
   * One group of participants, resolved and linked. The calendar transforms
   * still call this per event; it is {@link promoteParticipantGroups} for a
   * single group, so it costs the page-level path's fixed round trips once.
   */
  async processParticipants(
    participants: ParticipantInfo[],
    userId: string,
    connectionId: string,
    source: ParticipantSource,
    relationshipType: ParticipantRelationship,
    startDate?: Date,
    endDate?: Date,
  ): Promise<string[]> {
    const [ids] = await this.promoteParticipantGroups(toServiceContext({ userId }), {
      connectionId,
      source,
      groups: [{ participants, relationshipType, startDate, endDate }],
    });

    return ids;
  }

  /**
   * Gets a user entity and their corresponding graph node entity. If either of
   * these don't exist an error will be thrown.
   */
  async getUserAndEntity(context: ServiceContext, userId: string) {
    const user = await this.userService.findById(context, userId);

    if (user == null) {
      throw new Error('User could not be obtained');
    }

    const userNode = await this.nodeService.findNodeByUserId(context, userId);

    // This is a degenerate case resulting from an unlikely race condition. When
    // a user signs up we will asynchronously create a graph node for them. If
    // this work hasn't processed we cannot build relationships to the current
    // user so we should fail the job and retry.
    if (userNode == null) {
      throw new Error('User graph node could not be obtained');
    }

    return {
      user,
      userNode,
    };
  }
}
