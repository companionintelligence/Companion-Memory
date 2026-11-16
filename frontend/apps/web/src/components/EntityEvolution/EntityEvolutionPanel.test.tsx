import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EvolutionDelta } from '@/api/useEntityEvolutionService';

import { EntityEvolutionPanel } from './EntityEvolutionPanel';

const FOCUS_ID = '019fdcb3-b482-7101-af89-264466bf95ff';

const useEntityEvolutionService = vi.fn();

vi.mock('@/api/useEntityEvolutionService', () => ({
  useEntityEvolutionService: (props: unknown) => useEntityEvolutionService(props),
}));

function delta(overrides: Partial<EvolutionDelta> = {}): EvolutionDelta {
  return {
    deltaId: 'delta-1',
    nodeType: 'entity',
    entityId: FOCUS_ID,
    relationshipId: null,
    entityType: 'person',
    relationshipType: null,
    changeType: 'created',
    changedFields: {},
    fieldChanges: [],
    changeSource: null,
    changeReason: null,
    summaryId: null,
    changedAt: '2026-08-07T19:49:00.000Z',
    entity: { entityId: FOCUS_ID, entityType: 'person', name: 'Abdul Ameer' },
    fromEntity: null,
    toEntity: null,
    ...overrides,
  };
}

function mockDeltas(deltas: EvolutionDelta[]) {
  useEntityEvolutionService.mockReturnValue({
    data: {
      entityId: FOCUS_ID,
      deltas,
      stats: {
        total: deltas.length,
        firstChangedAt: null,
        lastChangedAt: null,
        created: 0,
        updated: 0,
        archived: 0,
        deleted: 0,
        merged: 0,
        entity: 0,
        relationship: 0,
      },
    },
    loading: false,
    error: null,
  });
}

/** The two records the reported screenshot showed: a LinkedIn import creating a person and a link. */
const IMPORT_DELTAS = [
  delta({
    deltaId: 'rel-1',
    nodeType: 'relationship',
    relationshipId: 'rel-1',
    relationshipType: 'KNOWS',
    fromEntity: { entityId: FOCUS_ID, entityType: 'person', name: 'Abdul Ameer' },
    toEntity: { entityId: 'user-1', entityType: 'person', name: 'Hanzla Mateen' },
  }),
  delta({
    deltaId: 'ent-1',
    fieldChanges: [
      { field: 'name', oldValue: null, newValue: 'Abdul Ameer' },
      { field: 'properties', oldValue: null, newValue: { URL: 'https://linkedin.com/in/x', Source: 'li' } },
      { field: 'description', oldValue: null, newValue: null },
    ],
  }),
];

describe('EntityEvolutionPanel', () => {
  it('says what the panel is, in words', () => {
    mockDeltas(IMPORT_DELTAS);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} entityName="Abdul Ameer" />);

    expect(screen.getByRole('heading', { name: 'Change History' })).toBeInTheDocument();
    expect(
      screen.getByText(/Every recorded change to Abdul Ameer and its relationships/),
    ).toBeInTheDocument();
  });

  it('counts only the change types that occurred', () => {
    mockDeltas(IMPORT_DELTAS);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText('Created 2')).toBeInTheDocument();
    // "Updated 0 / Deleted 0" was the panel's most prominent content, saying nothing.
    expect(screen.queryByText(/Updated 0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Deleted 0/)).not.toBeInTheDocument();
  });

  it('keeps the filter chips out of the way of a short history', () => {
    mockDeltas(IMPORT_DELTAS);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.queryByRole('button', { name: /Filters/ })).not.toBeInTheDocument();
    expect(screen.queryByText('All Time')).not.toBeInTheDocument();
  });

  it('offers filters once there is enough history to need them', () => {
    mockDeltas([
      delta({ deltaId: 'a' }),
      delta({ deltaId: 'b' }),
      delta({ deltaId: 'c' }),
      delta({ deltaId: 'd' }),
    ]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByRole('button', { name: /Filters/ })).toBeInTheDocument();
    // Still collapsed until asked for.
    expect(screen.queryByText('All Time')).not.toBeInTheDocument();
  });

  it('gives each filter group a distinct catch-all label', async () => {
    mockDeltas([
      delta({ deltaId: 'a' }),
      delta({ deltaId: 'b' }),
      delta({ deltaId: 'c' }),
      delta({ deltaId: 'd' }),
    ]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));

    // Three groups filter three different things — what changed, what happened to it, and when.
    // Naming two of the catch-alls after "changes" made them impossible to tell apart.
    expect(await screen.findByText('Everything')).toBeInTheDocument();
    expect(screen.getByText('Any Action')).toBeInTheDocument();
    expect(screen.getByText('All Time')).toBeInTheDocument();
    expect(screen.queryByText('All Changes')).not.toBeInTheDocument();
  });

  it('reads a creation as a birth rather than a diff from nothing', () => {
    mockDeltas(IMPORT_DELTAS);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText(/Added to your graph as Abdul Ameer/)).toBeInTheDocument();
    // "Name: empty -> Abdul Ameer" reads as a defect.
    expect(screen.queryByText(/empty ->/)).not.toBeInTheDocument();
  });

  it('drops field rows whose two sides are identical', () => {
    mockDeltas(IMPORT_DELTAS);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    // 'Description: empty -> empty' was rendered verbatim.
    expect(screen.queryByText(/Description:/)).not.toBeInTheDocument();
    expect(screen.getByText(/Name:/)).toBeInTheDocument();
  });

  it('still shows an object edit that keeps the same keys', () => {
    // The display form reduces an object to its key list, so comparing what is DISPLAYED to decide
    // whether a field changed silently hides this edit. An audit trail must not lose a real change.
    mockDeltas([
      delta({
        changeType: 'updated',
        fieldChanges: [
          {
            field: 'properties',
            oldValue: { URL: 'https://linkedin.com/in/abdul-a' },
            newValue: { URL: 'https://linkedin.com/in/abdul-b' },
          },
        ],
      }),
    ]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText(/Properties:/)).toBeInTheDocument();
  });

  it('still shows a long string edit that differs past the clip point', () => {
    const shared = 'x'.repeat(80);

    mockDeltas([
      delta({
        changeType: 'updated',
        fieldChanges: [{ field: 'description', oldValue: `${shared}AAA`, newValue: `${shared}BBB` }],
      }),
    ]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText(/Description:/)).toBeInTheDocument();
  });

  it('treats null and empty string as the same non-change', () => {
    mockDeltas([
      delta({
        changeType: 'updated',
        fieldChanges: [
          { field: 'description', oldValue: null, newValue: '' },
          { field: 'name', oldValue: 'Abdul', newValue: 'Abdul Ameer' },
        ],
      }),
    ]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.queryByText(/Description:/)).not.toBeInTheDocument();
    expect(screen.getByText(/Name:/)).toBeInTheDocument();
  });

  it('summarises an object by its keys instead of truncated JSON', () => {
    mockDeltas(IMPORT_DELTAS);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText(/2 fields: URL, Source/)).toBeInTheDocument();
    expect(screen.queryByText(/\{"URL"/)).not.toBeInTheDocument();
  });

  it('names the other end of a changed relationship', () => {
    mockDeltas(IMPORT_DELTAS);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText('New link to Hanzla Mateen')).toBeInTheDocument();
  });

  it('reads a merge as the record it went into, by name rather than id', () => {
    mockDeltas([
      delta({
        changeType: 'merged',
        changedFields: {
          merged_into_entity_id: { old: null, new: 'kept-1' },
          is_active: { old: true, new: false },
        },
        fieldChanges: [
          { field: 'merged_into_entity_id', oldValue: null, newValue: 'kept-1' },
          { field: 'is_active', oldValue: true, newValue: false },
        ],
        toEntity: { entityId: 'kept-1', entityType: 'person', name: 'Yuki Tanaka' },
      }),
    ]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText('Merged into Yuki Tanaka')).toBeInTheDocument();
    expect(screen.queryByText('Fields edited')).not.toBeInTheDocument();
    expect(screen.queryByText(/Merged Into Entity Id/)).not.toBeInTheDocument();
    expect(screen.getByText(/Is Active:/)).toBeInTheDocument();
  });

  it('does not read a merge row stored before merges recorded both sides as the name being cleared', () => {
    mockDeltas([
      delta({
        changeType: 'merged',
        changedFields: {
          name: { old: 'Yuki Tanaka' },
          merged_into_entity_id: { new: 'kept-1' },
        },
        fieldChanges: [
          { field: 'name', oldValue: 'Yuki Tanaka', newValue: null },
          { field: 'merged_into_entity_id', oldValue: null, newValue: 'kept-1' },
        ],
        toEntity: { entityId: 'kept-1', entityType: 'person', name: 'Yuki T.' },
      }),
    ]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText('Merged into Yuki T.')).toBeInTheDocument();
    expect(screen.queryByText(/Name:/)).not.toBeInTheDocument();
  });

  it('still reads a merge whose target can no longer be named', () => {
    mockDeltas([
      delta({
        changeType: 'merged',
        fieldChanges: [{ field: 'merged_into_entity_id', oldValue: null, newValue: 'gone-1' }],
        toEntity: null,
      }),
    ]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText('Merged into another record')).toBeInTheDocument();
  });

  it('drops the provenance tiles when there is no provenance', () => {
    mockDeltas(IMPORT_DELTAS);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    // Three tiles, two of them an em dash and the third repeating the header's timestamp.
    expect(screen.queryByText('Change Reason')).not.toBeInTheDocument();
    expect(screen.queryByText('Change Source')).not.toBeInTheDocument();
    expect(screen.queryByText('Changed At')).not.toBeInTheDocument();
  });

  it('shows provenance when the record carries any', () => {
    mockDeltas([delta({ changeSource: 'linkedin_import', changeReason: 'Initial sync' })]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText('Source: Linkedin Import')).toBeInTheDocument();
    expect(screen.getByText('Reason: Initial sync')).toBeInTheDocument();
  });

  it('explains an empty history rather than blaming the filters', () => {
    mockDeltas([]);

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText(/No changes recorded yet/)).toBeInTheDocument();
  });

  it('shows a loading state instead of an empty-history message while the fetch is in flight', () => {
    useEntityEvolutionService.mockReturnValue({ data: undefined, loading: true, error: null });

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText('Loading change history...')).toBeInTheDocument();
    // Loading is not the same as "we checked and there is nothing" — must not show both.
    expect(screen.queryByText(/No changes recorded yet/)).not.toBeInTheDocument();
  });

  it('surfaces the fetch failure instead of silently rendering an empty history', () => {
    useEntityEvolutionService.mockReturnValue({
      data: undefined,
      loading: false,
      error: new Error('network unreachable'),
    });

    render(<EntityEvolutionPanel entityId={FOCUS_ID} />);

    expect(screen.getByText('Unable to load change history: network unreachable')).toBeInTheDocument();
    expect(screen.queryByText(/No changes recorded yet/)).not.toBeInTheDocument();
    expect(screen.queryByText('Loading change history...')).not.toBeInTheDocument();
  });
});
