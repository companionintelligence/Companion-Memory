/**
 * Where an onboarded user lands: Planning, which resolves itself to the
 * Tasks sub-view, or Calendar if `planning.page` is off (see
 * RedirectToPlanningDefault in App.tsx) — Calendar is the page that
 * absorbed the brief, so that fallback is the same destination it always
 * was, under the name it goes by now.
 */
export function appHomePath(): '/plan' {
  return '/plan';
}
