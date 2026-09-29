import { useConnectionMode } from '@ci/common';

const COPY = {
  server: 'Please update your Memory server.',
  app: 'Please update your Memory app.',
} as const;

/**
 * One sentence on every signed-in page when the health check says this app
 * and the Memory server no longer speak the same contract. Hidden pages stay
 * hidden. This is what says why.
 */
export function MemoryContractStrip() {
  const { contractNotice, isResolved } = useConnectionMode();

  if (!isResolved || !contractNotice) {
    return null;
  }

  return (
    <p
      role="status"
      data-testid="memory-contract-notice"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
    >
      {COPY[contractNotice]}
    </p>
  );
}
