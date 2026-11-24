/** Resolve after `ms` milliseconds. Three services carried this one-liner; polling loops want one. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
