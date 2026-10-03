/**
 * Where an onboarded user lands: the Memory Explorer.
 *
 * This used to be Planning, which resolves itself to the Tasks sub-view — so
 * the end of a nine-step setup was "Nothing planned yet. Add your first task
 * above", a page about something the wizard never asked for. The Explorer is
 * where the wizard's work shows up (or, until it has, where its empty state
 * says "Connect a source" / "Import data"), and the getting-started banner
 * (components/GettingStarted) rides above it with live counts while the first
 * sync lands.
 *
 * Planning stays one click away on the rail; only the front door moved.
 */
export function appHomePath(): '/memory' {
  return '/memory';
}
