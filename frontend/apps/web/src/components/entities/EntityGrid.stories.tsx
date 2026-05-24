import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { makeFragmentData } from '@/graphql';
import {
  MOCK_ANSWERS,
  MOCK_COMMUNICATIONS,
  MOCK_CONCEPTS,
  MOCK_CONTENT,
  MOCK_ITEMS,
  MOCK_EVENTS,
  MOCK_FILES,
  MOCK_PEOPLE,
  MOCK_PLACES,
  MOCK_THREADS,
} from '@/graphql/mocks';

import { EntityGrid } from './EntityGrid';
import { AnswerGridItem, ANSWER_FRAGMENT } from './grid/AnswerGridItem';
import { CommunicationGridItem, COMMUNICATION_FRAGMENT } from './grid/CommunicationGridItem';
import { ConceptGridItem, CONCEPT_FRAGMENT } from './grid/ConceptGridItem';
import { ContentGridItem, CONTENT_FRAGMENT } from './grid/ContentGridItem';
import { EventGridItem, EVENT_FRAGMENT } from './grid/EventGridItem';
import { FileGridItem, FILE_FRAGMENT } from './grid/FileGridItem';
import { ItemGridItem, ITEM_FRAGMENT } from './grid/ItemGridItem';
import { PersonGridItem, PERSON_FRAGMENT } from './grid/PersonGridItem';
import { PlaceGridItem, PLACE_FRAGMENT } from './grid/PlaceGridItem';
import { ThreadGridItem, THREAD_FRAGMENT } from './grid/ThreadGridItem';

const items: (
  | (typeof MOCK_PEOPLE)[number]
  | (typeof MOCK_PLACES)[number]
  | (typeof MOCK_EVENTS)[number]
  | (typeof MOCK_THREADS)[number]
  | (typeof MOCK_FILES)[number]
  | (typeof MOCK_COMMUNICATIONS)[number]
  | (typeof MOCK_ITEMS)[number]
  | (typeof MOCK_CONTENT)[number]
  | (typeof MOCK_ANSWERS)[number]
  | (typeof MOCK_CONCEPTS)[number]
)[] = [];

const maxLength = Math.max(
  MOCK_PEOPLE.length,
  MOCK_PLACES.length,
  MOCK_EVENTS.length,
  MOCK_THREADS.length,
  MOCK_FILES.length,
  MOCK_COMMUNICATIONS.length,
  MOCK_ITEMS.length,
  MOCK_CONTENT.length,
  MOCK_ANSWERS.length,
  MOCK_CONCEPTS.length,
);

for (let i = 0; i < maxLength; i++) {
  if (i < MOCK_PEOPLE.length) {
    items.push(MOCK_PEOPLE[i]);
  }

  if (i < MOCK_PLACES.length) {
    items.push(MOCK_PLACES[i]);
  }

  if (i < MOCK_EVENTS.length) {
    items.push(MOCK_EVENTS[i]);
  }

  if (i < MOCK_THREADS.length) {
    items.push(MOCK_THREADS[i]);
  }

  if (i < MOCK_FILES.length) {
    items.push(MOCK_FILES[i]);
  }

  if (i < MOCK_COMMUNICATIONS.length) {
    items.push(MOCK_COMMUNICATIONS[i]);
  }

  if (i < MOCK_ITEMS.length) {
    items.push(MOCK_ITEMS[i]);
  }

  if (i < MOCK_CONTENT.length) {
    items.push(MOCK_CONTENT[i]);
  }

  if (i < MOCK_ANSWERS.length) {
    items.push(MOCK_ANSWERS[i]);
  }

  if (i < MOCK_CONCEPTS.length) {
    items.push(MOCK_CONCEPTS[i]);
  }
}

const meta: Meta = {
  parameters: {
    layout: 'padded',
  },

  args: {
    onClick: fn(),
  },

  render: (args) => {
    return (
      <EntityGrid>
        {items.map((item) => {
          switch (item.__typename) {
            case 'PersonType':
              return (
                <PersonGridItem
                  key={item.id}
                  person={makeFragmentData(item, PERSON_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            case 'PlaceType':
              return (
                <PlaceGridItem
                  key={item.id}
                  place={makeFragmentData(item, PLACE_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            case 'EventType':
              return (
                <EventGridItem
                  key={item.id}
                  event={makeFragmentData(item, EVENT_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            case 'ThreadType':
              return (
                <ThreadGridItem
                  key={item.id}
                  thread={makeFragmentData(item, THREAD_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            case 'FileType':
              return (
                <FileGridItem
                  key={item.id}
                  file={makeFragmentData(item, FILE_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            case 'CommunicationType':
              return (
                <CommunicationGridItem
                  key={item.id}
                  communication={makeFragmentData(item, COMMUNICATION_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            case 'ItemType':
              return (
                <ItemGridItem
                  key={item.id}
                  item={makeFragmentData(item, ITEM_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            case 'ContentType':
              return (
                <ContentGridItem
                  key={item.id}
                  content={makeFragmentData(item, CONTENT_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            case 'AnswerType':
              return (
                <AnswerGridItem
                  key={item.id}
                  answer={makeFragmentData(item, ANSWER_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            case 'ConceptType':
              return (
                <ConceptGridItem
                  key={item.id}
                  concept={makeFragmentData(item, CONCEPT_FRAGMENT)}
                  onClick={() => args.onClick(item.id)}
                />
              );

            default:
              return null;
          }
        })}
      </EntityGrid>
    );
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
