import { ErrorState as SharedErrorState, type ErrorStateProps } from '@/components/ErrorState';

/**
 * The Memory views' error state — the shared component with memory-worded copy.
 *
 * A thin wrapper rather than a re-export so the five explorer views that call
 * `<ErrorState onRetry={refetch} />` with no copy keep saying "your memories"
 * instead of the generic sentence. The component itself moved to
 * `@/components/ErrorState`; it is a shared concern, and living in this folder
 * is why pages outside Memory reached for it by relative path or did without.
 */
export function ErrorState({
  description = "We couldn't load your memories. Check your connection and try again.",
  ...props
}: ErrorStateProps) {
  return <SharedErrorState description={description} {...props} />;
}
