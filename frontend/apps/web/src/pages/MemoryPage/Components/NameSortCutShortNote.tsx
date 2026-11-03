import { useTranslation } from 'react-i18next';

/**
 * Said above a list sorted by name that the server cut short: a name sort with no search text reads
 * only each kind's newest 500 rows, so a bigger library is in name order but leaves its older rows
 * out (`SearchResultConnection.nameSortCutShort`). A search reaches them. A date range reaches
 * only the dated kinds: the explorer's When filter sets notes, files, content, people, places,
 * things and products aside (`resolveExplorerTypes`), so it cannot be the whole answer.
 */
export function NameSortCutShortNote() {
  const { t } = useTranslation();

  return (
    <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground" data-testid="name-sort-cut-short">
      {t('MEMORY_NAME_SORT_CUT_SHORT')}
    </p>
  );
}
