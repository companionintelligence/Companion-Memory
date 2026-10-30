import type { ImportBundle } from '../useImportApi';

/**
 * What `GET /import/sources/bundles` serves, reduced to the fields the
 * derivations read. The ids and members mirror the backend's authored list;
 * the instructions themselves are not this module's business.
 */
export const BUNDLES: readonly ImportBundle[] = [
  {
    id: 'google',
    ecosystem: 'google',
    title: 'Google (Takeout)',
    blurb: '',
    steps: [],
    members: [
      'gmail',
      'google_photos',
      'google_location',
      'google_calendar',
      'google_contacts',
      'youtube',
      'googlevoice',
      'google_my_activity',
      'google_maps_places',
      'google_keep',
      'google_purchases',
      'google_fit',
    ],
  },
  {
    id: 'meta',
    ecosystem: 'meta',
    title: 'Meta (Facebook, Instagram)',
    blurb: '',
    steps: [],
    members: ['facebook', 'instagram'],
  },
  {
    id: 'amazon',
    ecosystem: 'amazon',
    title: 'Amazon (Privacy Central)',
    blurb: '',
    steps: [],
    members: ['amazon', 'prime_video', 'audible', 'kindle_reading', 'amazon_music'],
  },
];
