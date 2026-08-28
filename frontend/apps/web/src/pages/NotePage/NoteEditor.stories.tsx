import { useMemo, useState } from 'react';

import { GlobalUID } from '@ci/common';
import { Editor } from '@ci/editor';
import type { EntityReferenceItem } from '@ci/editor';
import type { Meta, StoryObj } from '@storybook/react';

/**
 * Stories for the note editor's `[[` references, with the entity lookup stubbed
 * so the whole flow — trigger, filter, keyboard select, chip, serialised HTML —
 * is exercisable without the API behind it.
 */

const FIXTURES: EntityReferenceItem[] = [
  {
    uid: GlobalUID.encode('note', 'aaaaaaaa-0000-4000-8000-000000000001'),
    type: 'note',
    label: 'Weekly review',
  },
  {
    uid: GlobalUID.encode('note', 'aaaaaaaa-0000-4000-8000-000000000002'),
    type: 'note',
    label: 'Reading list',
  },
  {
    uid: GlobalUID.encode('person', 'bbbbbbbb-0000-4000-8000-000000000001'),
    type: 'person',
    label: 'Rajaa Asad',
  },
  {
    uid: GlobalUID.encode('person', 'bbbbbbbb-0000-4000-8000-000000000002'),
    type: 'person',
    label: 'Bennett Chamberlain',
  },
  {
    uid: GlobalUID.encode('place', 'cccccccc-0000-4000-8000-000000000001'),
    type: 'place',
    label: 'Reykjavík',
  },
  {
    uid: GlobalUID.encode('event', 'dddddddd-0000-4000-8000-000000000001'),
    type: 'event',
    label: 'Team offsite',
  },
  {
    uid: GlobalUID.encode('concept', 'eeeeeeee-0000-4000-8000-000000000001'),
    type: 'concept',
    label: 'Retrieval augmentation',
  },
  {
    uid: GlobalUID.encode('item', 'ffffffff-0000-4000-8000-000000000001'),
    type: 'item',
    label: 'Framework 13 laptop',
  },
];

const ROUTE_BY_TYPE: Record<string, string> = {
  concept: 'concepts',
  event: 'events',
  item: 'items',
  note: 'notes',
  person: 'people',
  place: 'places',
};

function ReferenceHarness({ content }: { content?: string }) {
  const [html, setHtml] = useState(content ?? '');

  const reference = useMemo(
    () => ({
      search: async (query: string) => {
        const needle = query.trim().toLowerCase();

        return FIXTURES.filter((item) => item.label.toLowerCase().includes(needle)).slice(0, 8);
      },
      resolveHref: ({ uid, type }: { uid: string; type: string }) =>
        `/${ROUTE_BY_TYPE[type] ?? type}/${GlobalUID.decode(uid).id}`,
    }),
    [],
  );

  return (
    <div className="flex h-full flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Type <code className="rounded bg-muted px-1">[[</code> then a few letters — try “re” or “ra”. ↑/↓ to
        move, Enter or Tab to insert, Escape to dismiss.
      </p>

      <div className="min-h-64 flex-1 rounded-md border border-border">
        <Editor content={content} onUpdate={setHtml} reference={reference}>
          <Editor.Content />
        </Editor>
      </div>

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Serialised HTML
        </div>
        <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap">
          {html || '<empty>'}
        </pre>
      </div>
    </div>
  );
}

const meta: Meta<typeof ReferenceHarness> = {
  title: 'components/NoteEditor',
  component: ReferenceHarness,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="h-screen w-full p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ReferenceHarness>;

/** Empty note — type `[[` to bring up the picker. */
export const References: Story = {};

/**
 * A note that already contains saved references, proving they parse back out of
 * stored HTML as chips rather than plain anchors.
 */
export const WithExistingReferences: Story = {
  args: {
    content: [
      '<p>Talked with ',
      `<a data-entity-uid="${FIXTURES[2].uid}" data-entity-type="person" data-entity-label="Rajaa Asad" class="ci-entity-reference">Rajaa Asad</a>`,
      ' about the ',
      `<a data-entity-uid="${FIXTURES[5].uid}" data-entity-type="event" data-entity-label="Team offsite" class="ci-entity-reference">Team offsite</a>`,
      ' — follow up in ',
      `<a data-entity-uid="${FIXTURES[0].uid}" data-entity-type="note" data-entity-label="Weekly review" class="ci-entity-reference">Weekly review</a>`,
      '.</p>',
    ].join(''),
  },
};
