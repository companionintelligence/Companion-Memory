/**
 * CI Entity Registry — the catalog of typed content an intent operates on.
 *
 * CI has a rich, cross-source entity graph (`ci.events`, `ci.people`, …); this
 * declares those types — each with a uniform identity + display descriptor — so
 * the intent manifest can describe what each intent consumes/produces and agents
 * can render/resolve them consistently.
 */

import type { CiEntityDescriptor } from '../types';

export const CI_ENTITIES: readonly CiEntityDescriptor[] = [
  {
    type: 'event',
    title: 'Event',
    description: 'A point or span on the personal timeline (meeting, photo capture, trip, purchase).',
    idKind: 'global-uid',
  },
  {
    type: 'person',
    title: 'Person',
    description: 'A person in the social graph — contact, family member, collaborator.',
    idKind: 'global-uid',
  },
  {
    type: 'place',
    title: 'Place',
    description: 'A location or venue the user has visited, saved, or referenced.',
    idKind: 'global-uid',
  },
  {
    type: 'content',
    title: 'Content',
    description: 'A bookmark, article, link, document, or web clip.',
    idKind: 'global-uid',
  },
  {
    type: 'communication',
    title: 'Communication',
    description: 'An email, message, chat, or notification.',
    idKind: 'global-uid',
  },
  {
    type: 'note',
    title: 'Note',
    description: 'A freeform personal note or annotation.',
    idKind: 'global-uid',
  },
  {
    type: 'file',
    title: 'File',
    description: 'A document, attachment, photo, or video binary in object storage.',
    idKind: 'global-uid',
  },
  {
    type: 'item',
    title: 'Item',
    description: 'A generic thing — product, book, game, or inventory entry.',
    idKind: 'global-uid',
  },
  {
    type: 'concept',
    title: 'Concept',
    description: 'An abstract idea, topic, or knowledge-graph node.',
    idKind: 'global-uid',
  },
  {
    type: 'browser-activity',
    title: 'Browser activity',
    description: 'A web page view, with dwell time and navigation context.',
    idKind: 'global-uid',
  },
] as const;
