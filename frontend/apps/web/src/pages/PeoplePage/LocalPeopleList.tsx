import { useTranslation } from 'react-i18next';

import type { LocalDocument } from '@/api/powersync/localSearch';
import { PersonAvatar } from '@/components/PersonAvatar';
import { LocalTypeList } from '@/pages/MemoryPage/LocalListView/LocalTypeList';

/**
 * The record's text minus the search-only tail: a person's body is their name
 * and then the JSON of their names and addresses the index matches on, which
 * is not a subtitle.
 */
function personSubtitle(person: LocalDocument): string {
  const text = (person.body ?? '').replace(/\s*\{[\s\S]*$/, '').trim();

  return text === (person.title ?? '').trim() ? '' : text;
}

/**
 * The people page while the Memory server does not answer: the person records
 * this phone has synced, by name, or ranked for the header box's `?search=`.
 * The per-type list with an avatar row; each row opens the saved record page.
 * No merge queue, identifiers or interaction counts — those are the appliance's.
 */
export function LocalPeopleList() {
  const { t } = useTranslation();

  return (
    <LocalTypeList
      entityType="person"
      heading="People"
      pageTitle="People & communications - Companion Memory"
      order="title"
      emptyTitle={t('MEMORY_LOCAL_PEOPLE_EMPTY_TITLE')}
      rowsClassName="flex flex-col gap-2"
      renderRow={(person, open) => (
        <button
          type="button"
          onClick={open}
          className="flex w-full items-center gap-3 rounded-md border bg-card p-3 text-left transition hover:bg-accent"
          data-testid="local-person-row"
        >
          <PersonAvatar name={person.title ?? ''} avatarUrl={null} size="md" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{person.title || 'Unnamed'}</div>
            <div className="truncate text-sm text-muted-foreground">{personSubtitle(person) || '—'}</div>
          </div>
        </button>
      )}
    />
  );
}
