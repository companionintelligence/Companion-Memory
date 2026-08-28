import { clusterPasses, displayNameFor, isDisplayableLabel, type QualityCluster } from './forecastQuality';

export type ForageLakePerson = {
  id: string;
  entityId: string;
  name: string;
};

export type ForageLakeBranch = {
  id: string;
  name: string;
  l0: string;
  prior: number;
  tokens: string[];
};

export type ForageLakeItem = {
  id: string;
  label: string;
  observation: string;
  supports_branches: string[];
  supports_people: string[];
  source: string;
};

export type ForageLakeSpec = {
  question: string;
  horizon: string;
  subject: string;
  seed: number;
  branches: string[];
  people: string[];
  items: ForageLakeItem[];
  branch_prior: Record<string, number>;
  interests: Array<{ branch: string; person: string; activities: string[] }>;
};

const STOP = new Set(['the', 'and', 'with', 'for', 'from', 'this', 'that', 'next']);

export function slugName(name: string, used: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'x';
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}_${n++}`;
  }

  used.add(id);

  return id;
}

export function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP.has(token));
}

export function supportingBranches(text: string, branches: ForageLakeBranch[]): string[] {
  const hay = text.toLowerCase();
  const hits = branches.filter(
    (branch) =>
      branch.tokens.some((token) => hay.includes(token)) ||
      (branch.l0 && hay.includes(branch.l0.toLowerCase())),
  );

  return hits.map((branch) => branch.id);
}

export function observationCue(item: {
  supports_branches: string[];
  supports_people: string[];
  source: string;
}): string {
  if (item.supports_branches.length === 1) {
    return `${item.supports_branches[0]}_mention`;
  }

  if (item.supports_people.length === 1) {
    return `${item.supports_people[0]}_mention`;
  }

  if (item.source === 'place' || item.source === 'person') {
    return 'place_mention';
  }

  return 'none';
}

export function expandQuery(args: {
  question: string;
  branch: string;
  people: string[];
}): string {
  const who = args.people.filter((name) => name !== 'solo').slice(0, 3).join(' ');

  return [args.branch, who, 'where they live home work places events'].filter(Boolean).join(' ');
}

export function peopleLinkedToEvents<T extends { entity_id: string; name: string }>(
  people: T[],
  linkedIds: Iterable<string>,
): T[] {
  const allowed = new Set(linkedIds);

  return people.filter((person) => allowed.has(person.entity_id) && isDisplayableLabel(person.name));
}

export function eventParticipantIds(events: Array<{
  organizer_entity_id?: string | null;
  participant_entity_ids?: string[] | null;
}>): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.organizer_entity_id) {
      ids.add(event.organizer_entity_id);
    }

    for (const id of event.participant_entity_ids ?? []) {
      if (id) {
        ids.add(id);
      }
    }
  }

  return [...ids];
}

export function branchesFromClusters(
  clusters: QualityCluster[],
  used: Set<string>,
  max = 4,
): ForageLakeBranch[] {
  const best = new Map<string, QualityCluster>();
  for (const cluster of clusters) {
    const key = cluster.name || cluster.l0_class;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, cluster);
      continue;
    }

    best.set(key, {
      ...prev,
      p_occur: Math.max(prev.p_occur, cluster.p_occur),
      scheduled: Boolean(prev.scheduled || cluster.scheduled),
      name: isDisplayableLabel(cluster.name) ? cluster.name : prev.name,
    });
  }

  return [...best.values()]
    .filter(clusterPasses)
    .sort((a, b) => {
      if (Boolean(a.scheduled) !== Boolean(b.scheduled)) {
        return a.scheduled ? -1 : 1;
      }

      return b.p_occur - a.p_occur;
    })
    .slice(0, max)
    .map((cluster) => {
      const name = displayNameFor(cluster) ?? cluster.name;
      const id = slugName(name, used);

      return {
        id,
        name,
        l0: cluster.l0_class,
        prior: cluster.p_occur,
        tokens: tokensOf(`${name} ${cluster.l0_class}`),
      };
    });
}
