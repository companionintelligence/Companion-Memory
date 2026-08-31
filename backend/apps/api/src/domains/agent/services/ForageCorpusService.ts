import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EntityResolutionService } from '@ci/domains/entity-resolution';
import { GraphExpansionService } from '@ci/domains/graph';
import { HbpeService, PlaceForecastService, type ForageTrialResponse } from '@ci/domains/predictions';
import { SearchService } from '@ci/domains/search-next';

import {
  branchesFromClusters,
  eventParticipantIds,
  expandQuery,
  observationCue,
  peopleLinkedToEvents,
  slugName,
  supportingBranches,
  tokensOf,
  type ForageLakeBranch,
  type ForageLakeItem,
  type ForageLakePerson,
  type ForageLakeSpec,
} from './forageCorpus';
import { SerializerService } from './SerializerService';

const MAX_PEOPLE = 8;
const MAX_ITEMS = 40;
const EXPAND_WHEN_UNREAD_BELOW = 4;

function emptyForageSpec(): ForageLakeSpec {
  return {
    question: 'What happens next',
    horizon: '7d',
    subject: '',
    seed: 0,
    branches: [],
    people: ['solo'],
    items: [],
    branch_prior: {},
    interests: [],
  };
}

type PersonRow = { entity_id: string; name: string };
type EventRow = {
  event_id: string;
  title: string;
  start_time: Date;
  location_name: string | null;
  location_entity_id: string | null;
  organizer_entity_id: string | null;
  participant_entity_ids: string[] | null;
  category: string | null;
  event_type: string | null;
};

@Injectable()
export class ForageCorpusService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly hbpeService: HbpeService,
    private readonly placeForecast: PlaceForecastService,
    private readonly searchService: SearchService,
    private readonly entityResolution: EntityResolutionService,
    private readonly graphExpansion: GraphExpansionService,
    private readonly serializer: SerializerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ForageCorpusService.name);
  }

  async ensure(context: UserServiceContext): Promise<ForageTrialResponse | null> {
    const existing = await this.hbpeService.getForage(context, false);
    if (existing?.kind === 'memory' && existing.attention.length > 0) {
      return existing;
    }

    return this.start(context);
  }

  async sample(context: UserServiceContext): Promise<ForageTrialResponse | null> {
    const current = await this.ensure(context);
    if (!current) {
      return null;
    }

    const extra = await this.expand(context, current);
    if (extra.length > 0) {
      await this.hbpeService.ingestForage(context, extra);
    }

    return this.hbpeService.forageSample(context);
  }

  async pin(context: UserServiceContext, branch: string): Promise<ForageTrialResponse | null> {
    const current = await this.ensure(context);
    if (!current) {
      return null;
    }

    return this.hbpeService.foragePin(context, branch);
  }

  async reset(context: UserServiceContext): Promise<ForageTrialResponse | null> {
    return this.start(context);
  }

  private async start(context: UserServiceContext): Promise<ForageTrialResponse | null> {
    const spec = await this.seed(context);
    if (spec.branches.length === 0) {
      return null;
    }

    return this.hbpeService.askForage(context, spec);
  }

  async seed(context: UserServiceContext): Promise<ForageLakeSpec> {
    const usedPeople = new Set<string>(['solo']);
    const usedBranches = new Set<string>();

    const [forecast, week, due, places, eventRows] = await Promise.all([
      this.hbpeService.getForecast(context, '24h').catch(() => null),
      this.hbpeService.getWeekForecast(context, true).catch(() => null),
      this.hbpeService.getDueList(context).catch(() => null),
      this.placeForecast.predictNext(context, 6, 24).catch(() => []),
      this.upcomingEvents(context),
    ]);

    if (forecast?.system_status !== 'READY' || forecast.still_learning) {
      return emptyForageSpec();
    }

    const branches = branchesFromClusters(week?.days.flatMap((day) => day.clusters) ?? [], usedBranches);
    const peopleRows = await this.peopleByIds(context, eventParticipantIds(eventRows));
    const people: ForageLakePerson[] = peopleLinkedToEvents(peopleRows, eventParticipantIds(eventRows)).map(
      (row) => ({
        entityId: row.entity_id,
        name: row.name,
        id: slugName(row.name.split(/\s+/)[0] || row.name, usedPeople),
      }),
    );
    const personByEntity = new Map(people.map((person) => [person.entityId, person.id]));

    const items: ForageLakeItem[] = [];
    const seen = new Set<string>();
    const add = (item: ForageLakeItem) => {
      if (seen.has(item.id) || items.length >= MAX_ITEMS) {
        return;
      }

      seen.add(item.id);
      items.push({ ...item, observation: observationCue(item) });
    };

    for (const event of eventRows) {
      const text = [event.title, event.location_name, event.category, event.event_type]
        .filter(Boolean)
        .join(' ');
      const participantIds = [event.organizer_entity_id, ...(event.participant_entity_ids ?? [])].filter(
        (id): id is string => Boolean(id),
      );
      add({
        id: `event:${event.event_id}`,
        label: `event: ${event.title}${event.location_name ? ` @ ${event.location_name}` : ''}`,
        observation: 'none',
        supports_branches: supportingBranches(text, branches),
        supports_people: participantIds
          .map((id) => personByEntity.get(id))
          .filter((id): id is string => Boolean(id)),
        source: 'event',
      });
    }

    for (const person of people) {
      add({
        id: `person:${person.entityId}`,
        label: `person: ${person.name}`,
        observation: 'none',
        supports_branches: [],
        supports_people: [person.id],
        source: 'person',
      });
    }

    for (const place of places) {
      const label = place.label || 'stay point';
      add({
        id: `derived:place:${place.clusterId}`,
        label: `derived: likely next place ${label}`,
        observation: 'none',
        supports_branches: supportingBranches(label, branches),
        supports_people: [],
        source: 'derived',
      });
    }

    for (const item of due?.due.slice(0, 6) ?? []) {
      add({
        id: `derived:due:${item.cluster_id}`,
        label: `derived: ${item.name} ${item.overdue ? 'overdue' : `due in ${item.due_in_days}d`}`,
        observation: 'none',
        supports_branches: supportingBranches(`${item.name} ${item.l0_class}`, branches),
        supports_people: [],
        source: 'derived',
      });
    }

    for (const branch of branches) {
      add({
        id: `derived:cluster:${branch.id}`,
        label: `derived: ${branch.name} often happens (${branch.l0.toLowerCase()})`,
        observation: 'none',
        supports_branches: [branch.id],
        supports_people: [],
        source: 'derived',
      });
    }

    const indexHits = await this.queryIndexes(
      context,
      'people places events where they live and who I see this week',
      branches,
      personByEntity,
    );
    for (const hit of indexHits) {
      add(hit);
    }

    const personIds = people.map((person) => person.entityId);
    if (personIds.length > 0) {
      const neighbours = await this.graphExpansion
        .expand(context, personIds, 'where they live home work places', new Set(personIds))
        .catch(() => []);
      for (const neighbour of neighbours) {
        add({
          id: `graph:${neighbour.entityId}`,
          label: neighbour.line,
          observation: 'none',
          supports_branches: supportingBranches(neighbour.line, branches),
          supports_people: people
            .filter((person) =>
              neighbour.line.toLowerCase().includes(person.name.toLowerCase().split(' ')[0]),
            )
            .map((person) => person.id),
          source: 'graph',
        });
      }
    }

    if (branches.length === 0) {
      return emptyForageSpec();
    }

    return {
      question: 'What happens next',
      horizon: '7d',
      subject: '',
      seed: 0,
      branches: branches.map((branch) => branch.id),
      people: ['solo', ...people.map((person) => person.id)],
      items,
      branch_prior: Object.fromEntries(branches.map((branch) => [branch.id, branch.prior])),
      interests: [],
    };
  }

  async expand(context: UserServiceContext, trial: ForageTrialResponse): Promise<ForageLakeItem[]> {
    const unread = trial.attention.filter((item) => !item.read).length;
    if (unread >= EXPAND_WHEN_UNREAD_BELOW) {
      return [];
    }

    const branch = trial.pin || trial.pick || trial.permutation_branch;
    const people = trial.permutations
      .filter((row) => row.label !== 'solo')
      .sort((a, b) => b.mass - a.mass)
      .slice(0, 3)
      .map((row) => row.label);
    const query = expandQuery({ question: trial.question, branch, people });
    const known = new Set(trial.attention.map((item) => item.id));
    const branches: ForageLakeBranch[] = trial.branches.map((row) => ({
      id: row.id,
      name: row.id,
      l0: '',
      prior: row.mass,
      tokens: tokensOf(row.id),
    }));
    const personByEntity = new Map<string, string>();
    const hits = await this.queryIndexes(context, query, branches, personByEntity);

    return hits.filter((item) => !known.has(item.id)).slice(0, 8);
  }

  private async peopleByIds(context: UserServiceContext, ids: string[]): Promise<PersonRow[]> {
    if (ids.length === 0) {
      return [];
    }

    try {
      return await this.dataSource.query(
        `SELECT e.entity_id,
                COALESCE(e.name, 'someone') AS name
           FROM ci.entities e
          WHERE e.owner_user_id = $1
            AND e.entity_type = 'Person'
            AND e.entity_id = ANY($2)
          LIMIT $3`,
        [context.userId, ids, MAX_PEOPLE],
      );
    } catch (err) {
      this.logger.warn('Forage people query failed', {
        err: err instanceof Error ? err.message : String(err),
      });

      return [];
    }
  }

  private async upcomingEvents(context: UserServiceContext): Promise<EventRow[]> {
    try {
      return await this.dataSource.query(
        `SELECT ev.event_id,
                COALESCE(ent.name, ev.event_type, 'event') AS title,
                ev.start_time,
                ev.location_name,
                ev.location_entity_id,
                ev.organizer_entity_id,
                ev.participant_entity_ids,
                ev.category,
                ev.event_type
           FROM ci.events ev
           LEFT JOIN ci.entities ent ON ent.entity_id = ev.event_id
          WHERE ev.user_id = $1
            AND ev.start_time >= NOW() - INTERVAL '3 days'
            AND ev.start_time < NOW() + INTERVAL '8 days'
          ORDER BY ev.start_time
          LIMIT 20`,
        [context.userId],
      );
    } catch (err) {
      this.logger.warn('Forage events query failed', {
        err: err instanceof Error ? err.message : String(err),
      });

      return [];
    }
  }

  private async queryIndexes(
    context: UserServiceContext,
    query: string,
    branches: ForageLakeBranch[],
    personByEntity: Map<string, string>,
  ): Promise<ForageLakeItem[]> {
    try {
      const hits = await this.searchService.search(context, {
        query,
        mode: 'boosted',
        maxResults: 12,
        excludeTypes: ['message', 'file-chunk'],
      });
      if (hits.length === 0) {
        return [];
      }

      const resolved = await this.entityResolution.resolve(context, hits);
      const items: ForageLakeItem[] = [];
      for (const hit of hits) {
        const entity = resolved.get(`${hit.type}:${hit.id}`);
        const label = entity ? this.serializer.serialize(entity) : `${hit.type}: ${hit.id}`;
        if (!label) {
          continue;
        }

        const supportsPeople =
          hit.type === 'person' && personByEntity.get(hit.id) ? [personByEntity.get(hit.id) as string] : [];
        items.push({
          id: `search:${hit.type}:${hit.id}`,
          label: `${hit.type}: ${label}`,
          observation: 'none',
          supports_branches: supportingBranches(label, branches),
          supports_people: supportsPeople,
          source: hit.type,
        });
      }

      return items;
    } catch (err) {
      this.logger.warn('Forage index query failed', {
        query,
        err: err instanceof Error ? err.message : String(err),
      });

      return [];
    }
  }
}
