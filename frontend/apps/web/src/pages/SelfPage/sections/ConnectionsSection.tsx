import { useState } from 'react';

import { Button } from '@ci/shadcn';
import { Link as LinkIcon, Users } from '@ci/shadcn/icons';

import { EntityRelationshipCards } from '@/components/EntityRelationshipCards/EntityRelationshipCards';
import { AddRelationshipModal } from '@/components/modals/AddItemModal/AddRelationshipModal';

/**
 * Every `person`→`person` relationship type except the four
 * `AboutYouSection`'s Family list already covers (SPOUSE/PARENT_OF/CHILD_OF/
 * SIBLING_OF), so a connection never renders twice across the two sections.
 * Also drops the communication-log-derived types (EMAILED, MESSAGED, CALLED,
 * COMMUNICATES_WITH, EDITED_WITH, ORGANIZED_EVENT_WITH, ASSOCIATED_WITH) —
 * signal exhaust from imports, not a relationship a person added on purpose.
 * Mirrors `RelationshipMap.person.person`
 * (backend/apps/api/src/domains/graph/types.ts).
 */
const NON_FAMILY_PERSON_TYPES = [
  'KNOWS',
  'FRIENDS_WITH',
  'PARTNER_OF',
  'FAMILY_MEMBER',
  'WORKS_WITH',
  'COLLABORATED_WITH',
  'INDUSTRY_CONNECTION',
  'SHARES_INTERESTS_WITH',
  'MENTORED',
  'TAUGHT',
  'CARES_FOR',
  'CLIENT_OF',
  'EMERGENCY_CONTACT_FOR',
  'SUPPORTS',
  'EMPLOYS',
  'LIVES_WITH',
  'MET_WITH',
];

interface Props {
  /** Raw graph entity id (not GlobalUID-encoded) — same id `EntityGraph`/`PersonPage` use. */
  entityId: string;
}

/** Friends, coworkers, roommates and other non-family connections — collected by onboarding's "people" step but, until now, shown nowhere on Self. */
export function ConnectionsSection({ entityId }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleAddClose = () => {
    setAddOpen(false);
    // The modal reports "closed" the same way on save and on cancel.
    // `EntityRelationshipCards` fetches its own graph data with no exposed
    // refetch, so remounting it (via `key`) is what notices a new edge — a
    // no-op re-fetch when the user cancelled.
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
          <h2 className="text-lg font-semibold">Friends &amp; Connections</h2>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <LinkIcon className="h-4 w-4" />
          Add relationship
        </Button>
      </div>

      <EntityRelationshipCards
        key={refreshKey}
        entityId={entityId}
        entityTypes={['person']}
        relationshipTypes={NON_FAMILY_PERSON_TYPES}
        heading="Connections"
      />

      <AddRelationshipModal
        entityId={entityId}
        entityType="person"
        allowedRelationshipTypes={{ person: NON_FAMILY_PERSON_TYPES }}
        open={addOpen}
        onClose={handleAddClose}
      />
    </section>
  );
}
