import { useMemo, useState } from 'react';

import { Badge, Button, Card, Input, Select, Skeleton } from '@ci/shadcn';
import { AlertCircle, ChevronLeft, ChevronRight, Plus, Search } from '@ci/shadcn/icons';

import { AnswerProvenance } from '@/components/AnswerProvenance';

import {
  ANSWER_TIERS,
  ANSWER_TIER_LABELS,
  type AnswerTier,
  type CatalogueAnswered,
  type CatalogueEntry,
  type CatalogueStatus,
  answerTierLabel,
  rangeLabel,
} from './catalogue';
import { EditReflectionDialog } from './EditReflectionDialog';
import { useReflectionCatalogue, type ReflectionDraft } from './useReflectionCatalogue';

/** Radix Select cannot hold an empty value, so "no filter" needs a sentinel. */
const ALL = '__all__';

const STATUS_OPTIONS: Array<{ value: CatalogueStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Deactivated' },
  { value: 'all', label: 'Active & deactivated' },
];

const ANSWERED_OPTIONS: Array<{ value: CatalogueAnswered; label: string }> = [
  { value: 'all', label: 'Answered or not' },
  { value: 'answered', label: 'Answered' },
  { value: 'unanswered', label: 'Unanswered' },
];

function ReflectionRow({
  entry,
  saving,
  onEdit,
  onToggleActive,
}: {
  entry: CatalogueEntry;
  saving: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  const tier = answerTierLabel(entry.answerTier);

  return (
    <Card className="p-4 gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <p className={`text-sm font-medium break-words ${entry.isActive ? '' : 'text-muted-foreground'}`}>
            {entry.text}
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            {entry.category ? (
              <Badge variant="secondary" className="text-xs">
                {entry.category}
              </Badge>
            ) : null}
            {tier ? (
              <Badge variant="outline" className="text-xs">
                {tier}
              </Badge>
            ) : null}
            {entry.isActive ? null : (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Deactivated
              </Badge>
            )}
            {entry.forkedFromQuestionId ? (
              <Badge
                variant="outline"
                className="text-xs text-muted-foreground"
                title="Your own copy of a shared reflection. Editing a shared one copies it first, so your wording is yours alone."
              >
                Your copy
              </Badge>
            ) : null}
            {entry.answer ? (
              // No `onEdit`: this row's Edit button rewrites the QUESTION
              // (EditReflectionDialog), not the answer, and there is no
              // answer-edit path on this surface. The drawer hides the
              // affordance rather than offering a second way to write.
              <AnswerProvenance
                source={entry.answer.source}
                confidence={entry.answer.confidence}
                rationale={entry.answer.rationale}
                details={{
                  question: entry.text,
                  answerText: entry.answer.text,
                  answeredAt: entry.answer.answeredAt,
                  record: entry.answer,
                }}
              />
            ) : (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Unanswered
              </Badge>
            )}
          </div>

          {entry.answer ? (
            <p className="text-sm text-muted-foreground break-words">{entry.answer.text}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={saving}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={onToggleActive} disabled={saving}>
            {entry.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * The browsable reflection catalogue.
 *
 * Before this, the only reflections reachable in the UI were the ~20 that
 * already had an answer, plus whichever single unanswered one the feed happened
 * to surface — roughly 2% of a ~1.3k-question catalogue. This lists all of it,
 * paged, filterable by category and answer type, searchable, and shows for each
 * row whether it has been answered and where that answer came from.
 */
export function ReflectionCatalogue() {
  const [{ page, loading, savingId, error, filters, searchInput }, actions] = useReflectionCatalogue();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CatalogueEntry | null>(null);
  // Deactivate/reactivate happens inline with no dialog to report into, so its
  // failure needs somewhere to land other than the console.
  const [actionError, setActionError] = useState<string | null>(null);

  const categories = useMemo(
    () =>
      (page?.facets.categories ?? [])
        .map((bucket) => bucket.value)
        .filter((value): value is string => Boolean(value)),
    [page],
  );

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (entry: CatalogueEntry) => {
    setEditing(entry);
    setDialogOpen(true);
  };

  const handleSave = async (draft: ReflectionDraft) => {
    if (editing) {
      await actions.update(editing.id, draft);

      return;
    }

    await actions.create(draft);
  };

  const range = page ? rangeLabel(page) : null;
  // The answered / unanswered counts come from the facets, which ignore the category,
  // answer-type and answered filters on purpose (those menus count the whole catalogue
  // too). Once one of them narrows the list the two numbers no longer add up to the
  // reflections listed, so they are labelled as totals rather than left to read as
  // the filtered split.
  const narrowed = filters.category !== null || filters.answerTier !== null || filters.answered !== 'all';
  const hasPrevious = filters.offset > 0;
  const hasNext = page ? filters.offset + page.data.length < page.totalCount : false;

  return (
    <div className="flex flex-col gap-4">
      {/* Same switch as the Answers tab's toolbar — on `lg:` the two tabs of this
          one page reflowed at different widths. */}
      <div className="flex flex-col gap-3 device:flex-row device:items-center device:justify-between">
        <div className="relative flex-1 device:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(event) => actions.setSearch(event.currentTarget.value)}
            placeholder="Search reflections"
            aria-label="Search reflections"
            className="pl-8"
          />
        </div>

        {/* A two-up grid on a phone, the same wrapping row from `sm` up. The
            four triggers below carry hard pixel widths (190/150/170/180) that
            never collapsed: on a 390px screen they wrapped into four ragged
            rows of mismatched pills, and on a 360px one the widest overflowed
            the content column. The widths stay for `sm`+, where they line the
            filters up; below that each trigger just fills its cell. */}
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <Select
            value={filters.category ?? ALL}
            onValueChange={(value) => actions.setCategory(value === ALL ? null : value)}
          >
            <Select.Trigger className="w-full sm:w-[190px]" aria-label="Filter by category">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={ALL}>All categories</Select.Item>
              {(page?.facets.categories ?? [])
                .filter((bucket) => bucket.value !== null)
                .map((bucket) => (
                  <Select.Item key={bucket.value} value={bucket.value as string}>
                    {bucket.value} ({bucket.count.toLocaleString()})
                  </Select.Item>
                ))}
            </Select.Content>
          </Select>

          <Select
            value={filters.answerTier ?? ALL}
            onValueChange={(value) => actions.setAnswerTier(value === ALL ? null : (value as AnswerTier))}
          >
            <Select.Trigger className="w-full sm:w-[150px]" aria-label="Filter by answer type">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={ALL}>All answer types</Select.Item>
              {ANSWER_TIERS.map((tier) => (
                <Select.Item key={tier} value={tier}>
                  {ANSWER_TIER_LABELS[tier]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>

          <Select
            value={filters.answered}
            onValueChange={(value) => actions.setAnswered(value as CatalogueAnswered)}
          >
            <Select.Trigger className="w-full sm:w-[170px]" aria-label="Filter by answered state">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {ANSWERED_OPTIONS.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  {option.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>

          <Select
            value={filters.status}
            onValueChange={(value) => actions.setStatus(value as CatalogueStatus)}
          >
            <Select.Trigger className="w-full sm:w-[180px]" aria-label="Filter by status">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {STATUS_OPTIONS.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  {option.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>

          <Button onClick={openCreate} className="col-span-2 w-full sm:w-auto">
            <Plus className="h-4 w-4" />
            New reflection
          </Button>
        </div>
      </div>

      {page ? (
        <p className="text-xs text-muted-foreground">
          {range ? `${range} reflections` : 'No reflections match these filters'}
          {' · '}
          {page.facets.answeredCount.toLocaleString()} answered,{' '}
          {page.facets.unansweredCount.toLocaleString()} unanswered{narrowed ? ' in total' : ''}
        </p>
      ) : null}

      {error ? (
        <div className="flex items-start gap-3 rounded-md bg-destructive/10 p-4 text-destructive">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <h3 className="font-medium">Error loading reflections</h3>
            <p className="text-sm">{error}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={actions.refresh}>
              Try Again
            </Button>
          </div>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {loading && !page ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2, 3, 4].map((key) => (
            <Skeleton key={key} className="h-24 w-full" />
          ))}
        </div>
      ) : null}

      {page && page.data.length === 0 && !loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No reflections match these filters.
        </div>
      ) : null}

      <div className={`flex flex-col gap-3 ${loading && page ? 'opacity-60' : ''}`}>
        {(page?.data ?? []).map((entry) => (
          <ReflectionRow
            key={entry.id}
            entry={entry}
            saving={savingId === entry.id}
            onEdit={() => openEdit(entry)}
            onToggleActive={() => {
              setActionError(null);
              void actions.setActive(entry.id, !entry.isActive).catch((err: unknown) => {
                setActionError(
                  err instanceof Error ? err.message : 'Could not change the reflection status.',
                );
              });
            }}
          />
        ))}
      </div>

      {page && page.totalCount > page.limit ? (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPrevious || loading}
            onClick={() => actions.goToPage(filters.offset - filters.limit)}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">{range}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext || loading}
            onClick={() => actions.goToPage(filters.offset + filters.limit)}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      <EditReflectionDialog
        open={dialogOpen}
        reflection={editing}
        categories={categories}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
      />
    </div>
  );
}
