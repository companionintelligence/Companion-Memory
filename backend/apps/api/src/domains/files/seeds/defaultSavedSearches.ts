/**
 * Starter saved-search library seeded once per user (issue #2003).
 *
 * LifeScope fixtures (https://github.com/LifeScopeLabs/lifescope-api/blob/master/fixtures/searches/initial_searches.json)
 * are mapped onto CI explorer fields — query / entityTypes / tags / SavedSearchFilters.
 * LifeScope "what" types that CI cannot express (audio, video, game, code, image as
 * first-class types) are approximated with file/event/communication plus eventTypes
 * or a query. Users can edit or delete any seed; we only insert when the user has
 * none, so a deletion is not undone on the next boot.
 */

import type { IndexableEntity } from '@ci/domains/search-next';

import type { SavedSearchFilters } from '../types';

export interface DefaultSavedSearchSeed {
  name: string;
  description: string;
  query?: string;
  entityTypes?: IndexableEntity[];
  tags?: string[];
  filters?: SavedSearchFilters | null;
}

const LAST_WEEK: SavedSearchFilters = { datePreset: 'last-week' };
const LAST_MONTH: SavedSearchFilters = { datePreset: 'last-month' };
// A Where search (`places` / `hasLocation` / `areas`) opens on the map: `view: 'map'`.
// That is where a place filter means something to look at; the list is a
// column of rows that happen to share a location name.

/**
 * Starter map areas as `[minLon, minLat, maxLon, maxLat]`. A region is a
 * rectangle, not a name: `places: ['New Zealand']` only matched events whose
 * place NAME contained the words, so an evening in "Queenstown" was never a
 * New Zealand trip. Deliberately generous — a starter should over-include
 * the coast and the islands rather than clip them.
 */
const AREA = {
  newZealand: [165.5, -47.5, 179.5, -33.5],
  japan: [122.5, 24, 146.5, 46],
  hawaii: [-161, 18.5, -154.5, 22.5],
  asia: [26, -11, 180, 82],
  africa: [-18, -35, 52, 38],
  europe: [-25, 34, 45, 72],
  americas: [-170, -56, -30, 72],
} satisfies Record<string, [number, number, number, number]>;

function seed(
  name: string,
  description: string,
  extras: Omit<DefaultSavedSearchSeed, 'name' | 'description'> = {},
): DefaultSavedSearchSeed {
  return { name, description, ...extras };
}

function named(
  name: string,
  extras: Omit<DefaultSavedSearchSeed, 'name' | 'description'> & { description?: string } = {},
): DefaultSavedSearchSeed {
  const { description, ...rest } = extras;

  return seed(name, description ?? `Starter search for ${name.toLowerCase()}.`, {
    query: rest.query ?? name,
    ...rest,
  });
}

/**
 * The nine LifeScope `initial_searches.json` starters, in fixture order.
 * These are the ones a fresh Memory should open with so the page looks complete.
 */
export const LIFESCOPE_SAVED_SEARCHES: DefaultSavedSearchSeed[] = [
  seed('Recent Entertainment', 'Audio, video, and games from the last week.', {
    entityTypes: ['file', 'event'],
    filters: {
      ...LAST_WEEK,
      eventTypes: ['played_music', 'game_played', 'favorite'],
    },
  }),
  // Every picture, whoever took it or wherever it came from: a photo library,
  // a capture from the phone, an MMS, a drive. The fixture's Google Photos
  // source narrowed this to one connector, and a query of "image" matched
  // nothing a photo is actually named — both are gone; the kind does the work.
  // No When: a file's own timestamp is its import time, not a real date, so
  // the explorer refuses a date window on files outright ("Files don't have
  // one"). "Recent" is the browse order instead — newest first.
  seed('Recent Images', 'Your pictures, newest first.', {
    entityTypes: ['file'],
    filters: { fileKinds: ['image'] },
  }),
  seed('Everything from the past week', 'Everything that landed in Memory over the last seven days.', {
    filters: LAST_WEEK,
  }),
  seed('Trophy Case', 'Achievements and unlocks.', {
    query: 'achievement',
    entityTypes: ['event', 'content'],
    filters: { eventTypes: ['achievement_unlocked'] },
  }),
  seed('Recent Social Media', 'Instagram, Reddit, Twitter, Facebook, and LinkedIn from the last week.', {
    filters: {
      ...LAST_WEEK,
      connectors: ['instagram', 'reddit', 'twitter', 'facebook', 'linkedin'],
    },
  }),
  seed('Recent Productivity', 'Files and code from Dropbox, Google, and GitHub this week.', {
    entityTypes: ['file'],
    query: 'code',
    filters: {
      ...LAST_WEEK,
      connectors: ['dropbox', 'google', 'gmail', 'github', 'github_events'],
    },
  }),
  // How: `email` is the source every mail import records on a communication,
  // whichever mailbox it came from. `gmail` / `google` were never a source a
  // message carries, so the fixture's filter matched nothing.
  seed('Recent Emails', 'Email from the last week.', {
    entityTypes: ['communication'],
    filters: {
      ...LAST_WEEK,
      connectors: ['email'],
    },
  }),
  seed('One year ago today', 'What was happening on this calendar day last year.', {
    filters: { datePreset: 'one-year-ago' },
  }),
  seed('All my stuff', 'Everything in Memory, unfiltered.'),
];

/**
 * The long named library. Each row is a best-effort mapping onto query /
 * entityTypes / who / where / when / source — skip or approximate anything CI
 * search cannot express (issue #2003 non-goal).
 */
const LIBRARY: Array<DefaultSavedSearchSeed & { name: string }> = [
  named('Every Birthday', { query: 'birthday', filters: { eventTypes: ['calendar_event'] } }),
  named('Favorite Sci Fi Books', { query: 'sci fi', entityTypes: ['item'] }),
  named('Work done during travel', { query: 'work', filters: { hasLocation: true, view: 'map' } }),
  named('Co-Working Spaces', { query: 'co-working', entityTypes: ['place'] }),
  named('Team Announcements', { query: 'announcement', entityTypes: ['communication'] }),
  named('KPI Target Reports', { query: 'KPI', entityTypes: ['file'] }),
  named('Stuff From Work Hours', { query: 'work' }),
  named('East Coast Archives', { query: 'east coast' }),
  named('Wedding Anniversary', { query: 'anniversary', filters: { eventTypes: ['calendar_event'] } }),
  named('Annual Review', { query: 'annual review', entityTypes: ['file'] }),
  named('Meatball Recipes', { query: 'meatball' }),
  named('Data is Beautiful', { query: 'data visualization' }),
  named('Home Utilities', { query: 'utility' }),
  named('Stock Tips', { query: 'stock' }),
  named('Weight Loss Journal', { query: 'weight' }),
  named('Molecular Biology', { query: 'molecular biology' }),
  named('Use of time', { query: 'time', entityTypes: ['event'] }),
  named('Pizza!', { query: 'pizza' }),
  named('Night on the Town', { query: 'nightlife', filters: { hasLocation: true, view: 'map' } }),
  named('My Surveys', { query: 'survey' }),
  named('Coffee Restaurants', { query: 'coffee', entityTypes: ['place'] }),
  named('Things in Storage', { query: 'storage', entityTypes: ['item'] }),
  named('Best Hike Locations', {
    query: 'hike',
    entityTypes: ['place'],
    filters: { hasLocation: true, view: 'map' },
  }),
  named('Digital Backups', { query: 'backup', entityTypes: ['file'] }),
  named('Copyrighted Material', { query: 'copyright' }),
  named('Snippets', { query: 'snippet', entityTypes: ['note'] }),
  named('Introductory Sales Templates', { query: 'sales template', entityTypes: ['file'] }),
  named('Email from Today', {
    description: 'Recent inbox mail. CI has no rolling today When preset, so this uses last week.',
    entityTypes: ['communication'],
    filters: { ...LAST_WEEK, connectors: ['email'] },
    query: undefined,
  }),
  named('Sent Messages', { query: 'sent', entityTypes: ['communication'] }),
  named('Data To Erase', { query: 'delete' }),
  named('New Glasses', { query: 'glasses' }),
  named('Asia Manufacturing', { query: 'manufacturing', filters: { areas: [AREA.asia], view: 'map' } }),
  named('Work Presentations', { query: 'presentation', entityTypes: ['file'] }),
  named('University Alumni', { query: 'alumni' }),
  named('Calls from Today', {
    description: 'Recent calls. Approximated with last week — there is no today When preset.',
    query: 'call',
    entityTypes: ['communication'],
    filters: LAST_WEEK,
  }),
  named('Social Networking', {
    query: undefined,
    filters: { connectors: ['instagram', 'twitter', 'reddit', 'facebook', 'linkedin'] },
  }),
  named('Braindump', { query: 'braindump', entityTypes: ['note'] }),
  named('New Contacts', { query: undefined, entityTypes: ['person'], filters: LAST_MONTH }),
  named('New Games', { query: undefined, filters: { ...LAST_MONTH, eventTypes: ['game_played'] } }),
  named('Tagged Objects', { query: undefined, entityTypes: ['item'] }),
  named('Recent Code at Home', {
    query: 'code',
    entityTypes: ['file'],
    filters: { ...LAST_WEEK, connectors: ['github', 'github_events'] },
  }),
  named('Night Life!', { query: 'nightlife' }),
  named('All my Music', { query: undefined, filters: { eventTypes: ['played_music', 'favorite'] } }),
  named('Favorite Stuff', { query: 'favorite' }),
  named('Cardio Workout', { query: 'cardio' }),
  named('1/5/10 Year Flashbacks', {
    description: 'One year ago today. Five- and ten-year windows are not a CI When preset.',
    query: undefined,
    filters: { datePreset: 'one-year-ago' },
  }),
  named('Recent Movies', { query: 'movie', filters: LAST_MONTH }),
  named('Scruffy', { query: undefined, filters: { people: ['Scruffy'] } }),
  named('Eating Out', { query: 'restaurant', filters: { hasLocation: true, view: 'map' } }),
  named('Futbol Club', { query: 'futbol' }),
  named('Haunted Houses', { query: 'haunted' }),
  named('Podcasts', { query: 'podcast', entityTypes: ['file'] }),
  named('Recycling', { query: 'recycling' }),
  named('Coupons', { query: 'coupon' }),
  named('Pet Park', { query: 'pet park', entityTypes: ['place'] }),
  named('Gaming Trophies', { query: undefined, filters: { eventTypes: ['achievement_unlocked'] } }),
  named('Fantasy Movies', { query: 'fantasy' }),
  named('Cat Memes', { query: 'cat' }),
  named('Peace', { query: 'peace' }),
  named('Fishing Trips', { query: 'fishing', filters: { hasLocation: true, view: 'map' } }),
  named('Rainforests', { query: 'rainforest' }),
  named('New Zealand Trip', { query: undefined, filters: { areas: [AREA.newZealand], view: 'map' } }),
  named('Camping Spots', { query: 'camping', entityTypes: ['place'] }),
  named('Meditations', { query: 'meditation' }),
  named('Best Drinking Spots', { query: 'bar', entityTypes: ['place'] }),
  named('Coaching', { query: 'coaching' }),
  named('Magic Spells', { query: 'spell' }),
  named('Vue.js Notes', { query: 'vue', entityTypes: ['note'] }),
  named('Volleyball', { query: 'volleyball' }),
  named('Hawaiian Volcano', { query: 'volcano', filters: { areas: [AREA.hawaii], view: 'map' } }),
  named('Japan Trip', { query: undefined, filters: { areas: [AREA.japan], view: 'map' } }),
  named('Chemistry Notes', { query: 'chemistry', entityTypes: ['note'] }),
  named('Gay Pride Parade', { query: 'pride' }),
  named('Anonymous', { query: 'anonymous' }),
  named('Pre-Med Applications', { query: 'pre-med' }),
  named('Beach Days', { query: 'beach' }),
  named('Must Binge TV', { query: 'tv show' }),
  named('Monster Trucks', { query: 'monster truck' }),
  named('Christmas Party', { query: 'christmas' }),
  named('Dentist Trips', { query: 'dentist' }),
  named('LARPing', { query: 'larp' }),
  named('Space Videos', { query: 'space', entityTypes: ['file'] }),
  named('Python ML Projects', { query: 'python', entityTypes: ['file'] }),
  named('Bridge Notes', { query: 'bridge', entityTypes: ['note'] }),
  named('Space Shuttle', { query: 'shuttle' }),
  named('Messages to Me', { query: undefined, entityTypes: ['communication'] }),
  named('January Ski Trips', { query: 'ski' }),
  named('Hanukkah', { query: 'hanukkah' }),
  named('Christmas at Home', { query: 'christmas' }),
  named('Christmas Away', { query: 'christmas', filters: { hasLocation: true, view: 'map' } }),
  named('Secular Club', { query: 'secular' }),
  named('Passover', { query: 'passover' }),
  named('Linux Notes', { query: 'linux', entityTypes: ['note'] }),
  named('Halloween', { query: 'halloween' }),
  named('Horror Movies', { query: 'horror' }),
  named('Marijuana', { query: 'cannabis' }),
  named('Starbucks', { query: 'starbucks' }),
  named('Republican Policies', { query: 'republican' }),
  named('Democratic Presidential Candidates', { query: 'democrat' }),
  named('Darth Vader', { query: 'vader', filters: { people: ['Darth Vader'] } }),
  named('Gas Expenses', { query: 'gas' }),
  named('Star Trek', { query: 'star trek' }),
  named('New Ideas', { query: 'idea', entityTypes: ['note'] }),
  named('Bowling', { query: 'bowling' }),
  named('Best Bud', { query: 'friend' }),
  named('Pac Man Achievements', { query: 'pac man', filters: { eventTypes: ['achievement_unlocked'] } }),
  named('Democratic Socialism', { query: 'socialism' }),
  named('NCAA Hockey', { query: 'hockey' }),
  named('Best AirBnB', { query: 'airbnb', entityTypes: ['place'] }),
  named('Beauty Tips', { query: 'beauty' }),
  named('Home Vegetable Farming', { query: 'garden' }),
  named('Data Science R Notebook', { query: 'data science', entityTypes: ['file'] }),
  named('Top Mobile Apps', { query: 'app' }),
  named('Boat Trips', { query: 'boat' }),
  named('DnD Spells', { query: 'dnd spell' }),
  named('DnD Campaigns', { query: 'dnd' }),
  named('Asia', { query: undefined, filters: { areas: [AREA.asia], view: 'map' } }),
  named('Africa', { query: undefined, filters: { areas: [AREA.africa], view: 'map' } }),
  named('Europe', { query: undefined, filters: { areas: [AREA.europe], view: 'map' } }),
  named('Americas', { query: undefined, filters: { areas: [AREA.americas], view: 'map' } }),
  named('Gas Bills', { query: 'gas bill' }),
  named('Cleanups', { query: 'cleanup' }),
  named('Car Accidents', { query: 'accident' }),
  named('My Playlists', { query: 'playlist', filters: { eventTypes: ['played_music'] } }),
  named('New Code Branches', { query: 'branch', filters: { connectors: ['github', 'github_events'] } }),
  named('Boxing Highlights', { query: 'boxing' }),
  named('Old Photos', { query: 'photo', entityTypes: ['file'] }),
  named('Medications', { query: 'medication' }),
  named('Acoustic Music', { query: 'acoustic', filters: { eventTypes: ['played_music'] } }),
  named('Off Season Baseball News', { query: 'baseball' }),
  named('Science Articles', { query: 'science' }),
  named('Shopping List', { query: 'shopping', entityTypes: ['note'] }),
];

// The character / joke searches from the product session ("Yoga for the Power
// Mad", "Space Car", …) used to sit between these two. Removed 2026-10-15: they
// named people and places that exist in no real account.
export const DEFAULT_SAVED_SEARCHES: DefaultSavedSearchSeed[] = [...LIFESCOPE_SAVED_SEARCHES, ...LIBRARY];
