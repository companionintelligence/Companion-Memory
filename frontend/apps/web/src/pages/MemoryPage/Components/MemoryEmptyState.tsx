import { Button } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { useOptionalFeatures } from '@/common/feature';

import { Empty } from './Empty';

interface MemoryEmptyStateProps {
  /** True when URL filters or a search query narrowed the browse. */
  filtered: boolean;
  /**
   * What-picker types (display names) the When filter set aside because they
   * carry no date — see resolveExplorerTypes. When non-empty, the empty state
   * explains that instead of the generic "try clearing your filters".
   */
  whenDroppedTypes?: readonly string[];
}

// How the What bar names each type it can set aside (entityTypeCategories).
const TYPE_LABELS: Record<string, string> = {
  Content: 'Content',
  File: 'Files',
  Note: 'Notes',
  Person: 'People',
  Place: 'Places',
  Product: 'Products',
  Thing: 'Things',
};

function listNames(types: readonly string[]): string {
  const names = types.map((type) => TYPE_LABELS[type] ?? type);

  if (names.length <= 1) {
    return names.join('');
  }

  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Why a When filter can hide a whole selection: the reader picked kinds that
 * have no date, so no date range can ever include them. Says which kinds and
 * what to do about it, in the What bar's own words for them.
 */
export function whenFilterNudge(types: readonly string[]): string {
  const names = listNames(types);
  // "Content" reads as a mass noun; every other label is a plural.
  const plural = types.length > 1 || (types.length === 1 && types[0] !== 'Content');
  const have = plural ? "don't have" : "doesn't have";
  const them = plural ? 'them' : 'it';

  return `A When filter only shows things that have a date, and ${names} ${have} one. Remove the When filter to see ${them} again.`;
}

export function MemoryEmptyState({ filtered, whenDroppedTypes = [] }: MemoryEmptyStateProps) {
  // Optional on purpose: the "no results" branches below never read a flag,
  // and this component is rendered bare by its own tests. Outside a
  // FeaturesProvider the gated button simply stays hidden.
  const features = useOptionalFeatures();
  // Same flag /sources/import is gated behind. With it off SourcesPage
  // normalises that half away to /sources/connect, so the button would just be
  // a second, differently-worded "Connect a source" — drop it instead.
  const importEnabled = features?.isFeatureEnabled('import.page') ?? false;

  if (whenDroppedTypes.length > 0) {
    return <Empty title="No results" description={whenFilterNudge(whenDroppedTypes)} icon="🔍" />;
  }

  if (filtered) {
    return (
      <Empty
        title="No results"
        description="Try clearing your filters or searching for something else."
        icon="🔍"
      />
    );
  }

  return (
    <div className="flex flex-col items-center px-6 py-12">
      <Empty
        title="Your memory is empty"
        description="Connect a source or import data to start building your timeline."
        icon="✨"
      />
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button asChild>
          <Link to="/sources/connect">Connect a source</Link>
        </Button>
        {importEnabled && (
          <Button variant="outline" asChild>
            <Link to="/sources/import">Import data</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
