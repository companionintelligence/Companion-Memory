/**
 * The feature flags the appliance last answered with, kept per phone so they still
 * apply while the appliance cannot be reached.
 *
 * The routes behind flags (`self.page`, `chat.page`, `files.page`…) exist only while
 * their flag is on, and the flags come from the appliance on every launch. With the
 * appliance away, a launch that forgot them rendered the app's 404 for Settings and
 * the profile, which read as "signed out" — on a phone that still held the user's key,
 * their profile (see `rememberedUser.ts`) and their whole memory. The flags are a
 * property of the account and the box, not of the connection, so the last known set
 * is the right answer until the box says otherwise.
 *
 * Per-user flags are remembered with the subject they were fetched for and recalled
 * only for that subject at that origin; the global set is per origin.
 */

export type Features = Record<string, boolean>;

const USER_KEY = 'ci.rememberedFeatures';
const GLOBAL_KEY = 'ci.rememberedGlobalFeatures';

interface RememberedUserFeatures {
  origin: string;
  subject: string;
  features: Features;
}

interface RememberedGlobalFeatures {
  origin: string;
  features: Features;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);

    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the flags still apply for this session.
  }
}

export function rememberFeatures(origin: string, subject: string, features: Features): void {
  write(USER_KEY, { origin, subject, features } satisfies RememberedUserFeatures);
}

/** The per-user flags last fetched for `subject` at `origin`, or null for anyone or anywhere else. */
export function recallFeatures(origin: string, subject: string | null | undefined): Features | null {
  const kept = read<Partial<RememberedUserFeatures>>(USER_KEY);

  return kept && kept.origin === origin && subject != null && kept.subject === subject && kept.features
    ? kept.features
    : null;
}

export function rememberGlobalFeatures(origin: string, features: Features): void {
  write(GLOBAL_KEY, { origin, features } satisfies RememberedGlobalFeatures);
}

export function recallGlobalFeatures(origin: string): Features | null {
  const kept = read<Partial<RememberedGlobalFeatures>>(GLOBAL_KEY);

  return kept && kept.origin === origin && kept.features ? kept.features : null;
}

/** On sign-out: the next person at this phone starts from the box's answer, not this one's. */
export function forgetFeatures(): void {
  try {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(GLOBAL_KEY);
  } catch {
    // Nothing to forget.
  }
}
