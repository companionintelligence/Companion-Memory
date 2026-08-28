import { useEffect, useState } from 'react';

import { gql, useApolloClient } from '@apollo/client';
import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';
import type { CataloguePage } from '@/pages/PromptsPage/catalogue';
import { HOME_TOWN_CITY_QUESTION_KEYS, homeTownCatalogueUrl } from '@/pages/SelfPage/sections/lifeDetails';

/** City-scale zoom — same as the Map default, without fitting the whole pin set. */
export const HOME_MAP_ZOOM = 13;

const HOME_PLACE_QUERY = gql`
  query HomeMapPlace($query: String, $first: Int) {
    places(query: $query, first: $first) {
      edges {
        node {
          id
          name
          latitude
          longitude
        }
      }
    }
  }
`;

export interface HomePlaceNode {
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[.,]/g, '');
}

/**
 * Childhood city first, then birth city. Empty / missing answers are skipped.
 */
export function pickHomeCity(
  page:
    | { data?: Array<{ key?: string | null; answer?: { text?: string | null } | null }> }
    | null
    | undefined,
): string | null {
  // Keyed by `question_key`, not `id`: the id is minted per appliance, so
  // indexing by it finds nothing on any database but the one the ids were
  // copied from — see lifeDetails.ts.
  const byKey = new Map(
    (page?.data ?? []).flatMap((entry) =>
      entry.key ? [[entry.key, entry.answer?.text?.trim() ?? ''] as const] : [],
    ),
  );

  for (const key of HOME_TOWN_CITY_QUESTION_KEYS) {
    const text = byKey.get(key);
    if (text) {
      return text;
    }
  }

  return null;
}

/**
 * Match an existing Place by name. No forward geocode — if the city is not
 * already a located Place, the map keeps its current default + fit-to-pins.
 */
export function pickHomePlace(
  edges: Array<{ node?: HomePlaceNode | null } | null> | null | undefined,
  city: string,
): { latitude: number; longitude: number } | null {
  const needle = normalizeName(city);
  if (!needle) {
    return null;
  }

  const located = (edges ?? [])
    .map((edge) => edge?.node)
    .filter(
      (node): node is { name: string; latitude: number; longitude: number } =>
        typeof node?.name === 'string' &&
        typeof node.latitude === 'number' &&
        typeof node.longitude === 'number',
    );

  const exact = located.find((node) => normalizeName(node.name) === needle);
  if (exact) {
    return { latitude: exact.latitude, longitude: exact.longitude };
  }

  const prefix = located.find((node) => {
    const name = normalizeName(node.name);

    return name.startsWith(needle) || needle.startsWith(name);
  });
  if (prefix && Math.min(normalizeName(prefix.name).length, needle.length) >= 3) {
    return { latitude: prefix.latitude, longitude: prefix.longitude };
  }

  return null;
}

/**
 * Mobile Memory map starting camera: the signed-in person's Self home town,
 * resolved through an existing Place. `enabled` is false on the shared viewer
 * so we never aim someone else's pins at the viewer's home.
 */
export function useHomeMapCenter(enabled = true): {
  center: [number, number] | null;
  resolved: boolean;
} {
  const [{ authToken }] = useAuth();
  const client = useApolloClient();
  const [center, setCenter] = useState<[number, number] | null>(null);
  const [resolved, setResolved] = useState(!enabled);

  useEffect(() => {
    if (!enabled) {
      setCenter(null);
      setResolved(true);

      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const page = await fetchJson<CataloguePage>(homeTownCatalogueUrl(), {
          headers: { ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        });
        const city = pickHomeCity(page);
        if (!city) {
          if (!cancelled) {
            setResolved(true);
          }

          return;
        }

        const { data } = await client.query({
          query: HOME_PLACE_QUERY,
          variables: { query: city, first: 20 },
        });
        const place = pickHomePlace(data?.places?.edges ?? [], city);
        if (!cancelled) {
          if (place) {
            setCenter([place.latitude, place.longitude]);
          }

          setResolved(true);
        }
      } catch {
        if (!cancelled) {
          setResolved(true);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [authToken, client, enabled]);

  return { center, resolved };
}
