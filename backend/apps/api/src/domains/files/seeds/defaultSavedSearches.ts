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
  seed('Recent Images', 'Images from the last week.', {
    entityTypes: ['file'],
    query: 'image',
    filters: {
      ...LAST_WEEK,
      connectors: ['google_photos'],
    },
  }),
  seed('Everything from the past week', 'Everything that landed in Memory over the last seven days.', {
    filters: LAST_WEEK,
  }),
  seed('Trophy Case', 'Achievements and unlocks.', {
    query: 'achievement',
    entityTypes: ['event', 'content'],
    filters: { eventTypes: ['achievement_unlocked'] },
  }),
  seed('Recent Social Media', 'Instagram, Reddit, and Twitter from the last week.', {
    filters: {
      ...LAST_WEEK,
      connectors: ['instagram', 'reddit', 'twitter'],
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
  seed('Recent Emails', 'Email from the last week.', {
    entityTypes: ['communication'],
    filters: {
      ...LAST_WEEK,
      connectors: ['gmail', 'google'],
      eventTypes: ['email', 'messaged'],
    },
  }),
  seed('One year ago today', 'What was happening on this calendar day last year.', {
    filters: { datePreset: 'one-year-ago' },
  }),
  seed('All my stuff', 'Everything in Memory, unfiltered.'),
];

/**
 * Character / joke searches from the product session. Who / where use ILIKE
 * name patterns, so they light up when those people or places exist (John Smith
 * seed or a real import) and stay empty otherwise.
 */
export const DEMO_SAVED_SEARCHES: DefaultSavedSearchSeed[] = [
  seed('Yoga for the Power Mad', 'Where filter with a horribly punny name of a studio.', {
    query: 'yoga',
    filters: { places: ['Crystal Healing Yoga Studio', 'Subterranean Vipassana'] },
  }),
  seed('Space Car', 'Blueprints from Jeeves Brannigan at the VoidZ testing facility.', {
    query: 'Blueprints',
    entityTypes: ['file'],
    filters: { people: ['Jeeves Brannigan'], places: ['VoidZ testing facility'] },
  }),
  seed('MicroFlesh Diet', 'The branded-meat discourse, captured as tags.', {
    query: '#NotBeyondMeat #PossibleBurger',
  }),
  seed(
    'Weed Podcasts',
    'Audio from Roe Jogan. The 4/20 date is the joke; CI has no recurring April-20 filter.',
    {
      query: 'podcast',
      entityTypes: ['file'],
      filters: { people: ['Roe Jogan'] },
    },
  ),
  seed('Project Gay Bomb', 'Research photos.', {
    query: 'research',
    entityTypes: ['file'],
  }),
  seed("Rocketwoman's Voyage", 'Space pics and emails from Rocketwoman.', {
    query: 'space',
    entityTypes: ['file', 'communication'],
    filters: { people: ['Rocketwoman'] },
  }),
  seed('DynamicHoop progress', 'Files and emails from Chicago.', {
    entityTypes: ['file', 'communication'],
    filters: { places: ['Chicago'] },
  }),
];

/**
 * The long named library. Each row is a best-effort mapping onto query /
 * entityTypes / who / where / when / source — skip or approximate anything CI
 * search cannot express (issue #2003 non-goal).
 */
const LIBRARY: Array<DefaultSavedSearchSeed & { name: string }> = [
  named('Every Birthday', { query: 'birthday', filters: { eventTypes: ['calendar_event'] } }),
  named('Favorite Sci Fi Books', { query: 'sci fi', entityTypes: ['item'] }),
  named('Work done during travel', { query: 'work', filters: { hasLocation: true } }),
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
  named('Night on the Town', { query: 'nightlife', filters: { hasLocation: true } }),
  named('My Surveys', { query: 'survey' }),
  named('Coffee Restaurants', { query: 'coffee', entityTypes: ['place'] }),
  named('Things in Storage', { query: 'storage', entityTypes: ['item'] }),
  named('Best Hike Locations', { query: 'hike', entityTypes: ['place'], filters: { hasLocation: true } }),
  named('Digital Backups', { query: 'backup', entityTypes: ['file'] }),
  named('Copyrighted Material', { query: 'copyright' }),
  named('Snippets', { query: 'snippet', entityTypes: ['note'] }),
  named('Introductory Sales Templates', { query: 'sales template', entityTypes: ['file'] }),
  named('Email from Today', {
    description: 'Recent inbox mail. CI has no rolling today When preset, so this uses last week.',
    entityTypes: ['communication'],
    filters: { ...LAST_WEEK, connectors: ['gmail'] },
    query: undefined,
  }),
  named('Sent Messages', { query: 'sent', entityTypes: ['communication'] }),
  named('Data To Erase', { query: 'delete' }),
  named('New Glasses', { query: 'glasses' }),
  named('Asia Manufacturing', { query: 'manufacturing', filters: { places: ['Asia'] } }),
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
  named('Eating Out', { query: 'restaurant', filters: { hasLocation: true } }),
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
  named('Fishing Trips', { query: 'fishing', filters: { hasLocation: true } }),
  named('Rainforests', { query: 'rainforest' }),
  named('New Zealand Trip', { query: undefined, filters: { places: ['New Zealand'] } }),
  named('Camping Spots', { query: 'camping', entityTypes: ['place'] }),
  named('Meditations', { query: 'meditation' }),
  named('Best Drinking Spots', { query: 'bar', entityTypes: ['place'] }),
  named('Coaching', { query: 'coaching' }),
  named('Magic Spells', { query: 'spell' }),
  named('Vue.js Notes', { query: 'vue', entityTypes: ['note'] }),
  named('Volleyball', { query: 'volleyball' }),
  named('Hawaiian Volcano', { query: 'volcano', filters: { places: ['Hawaii'] } }),
  named('Japan Trip', { query: undefined, filters: { places: ['Japan'] } }),
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
  named('Christmas Away', { query: 'christmas', filters: { hasLocation: true } }),
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
  named('Asia', { query: undefined, filters: { places: ['Asia'] } }),
  named('Africa', { query: undefined, filters: { places: ['Africa'] } }),
  named('Europe', { query: undefined, filters: { places: ['Europe'] } }),
  named('Americas', { query: undefined, filters: { places: ['America'] } }),
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

export const DEFAULT_SAVED_SEARCHES: DefaultSavedSearchSeed[] = [
  ...LIFESCOPE_SAVED_SEARCHES,
  ...DEMO_SAVED_SEARCHES,
  ...LIBRARY,
];
