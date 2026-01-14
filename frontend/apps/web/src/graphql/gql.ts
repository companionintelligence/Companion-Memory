/* ------------------------------------------------------- */
/*  THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)  */
/* ------------------------------------------------------- */

/* eslint-disable */
import * as types from './graphql';
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';

/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
    "\n  query GetActions {\n    actions {\n      edges {\n        node {\n          id\n          title\n          text\n          imageUrl\n          thread {\n            id\n          }\n          tags {\n            label\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetActionsDocument,
    "\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      tags {\n        label\n      }\n      ... on Node {\n        id\n      }\n    }\n  }\n": typeof types.TagEntitiesDocument,
    "\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      tags {\n        label\n      }\n      ... on Node {\n        id\n      }\n    }\n  }\n": typeof types.UntagEntitiesDocument,
    "\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        label\n      }\n    }\n  }\n": typeof types.GetCommunicationDocument,
    "\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n": typeof types.GetConceptDocument,
    "\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        label\n      }\n    }\n  }\n": typeof types.GetContentDocument,
    "\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetEventDocument,
    "\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          periodStart\n          periodEnd\n          summaryText\n          keyInsights\n          notableEvents\n          anomalies\n          tags\n          activityCounts {\n            total\n            browserActivity\n            communications\n            files\n          }\n          dailyRhythm\n          productivityPatterns\n          socialInteractions\n          keyAccomplishments\n          moodIndicators\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n": typeof types.GetSummariesDocument,
    "\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n": typeof types.GetSummaryDocument,
    "\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    originalName\n    contentType\n    url\n    createdAt\n  }\n": typeof types.FileGridItemFragmentFragmentDoc,
    "\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n": typeof types.GetFilesDocument,
    "\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            url\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetInventoryItemsDocument,
    "\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n": typeof types.GetItemDocument,
    "\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n": typeof types.CreateSavedSearchDocument,
    "\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n    }\n  }\n": typeof types.GetSavedSearchDocument,
    "\n  fragment GalleryAnswerCardData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": typeof types.GalleryAnswerCardDataFragmentDoc,
    "\n  fragment GalleryBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": typeof types.GalleryBrowserActivityCardDataFragmentDoc,
    "\n  fragment GalleryCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": typeof types.GalleryCommunicationCardDataFragmentDoc,
    "\n  fragment GalleryConceptCardData on ConceptType {\n    id\n    name\n    description\n  }\n": typeof types.GalleryConceptCardDataFragmentDoc,
    "\n  fragment GalleryContentCardData on ContentType {\n    id\n    title\n    text\n  }\n": typeof types.GalleryContentCardDataFragmentDoc,
    "\n  fragment GalleryEventCardData on EventType {\n    id\n    title\n    description\n  }\n": typeof types.GalleryEventCardDataFragmentDoc,
    "\n  fragment GalleryFileCardData on FileType {\n    id\n    url\n  }\n": typeof types.GalleryFileCardDataFragmentDoc,
    "\n  fragment GalleryItemCardData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      url\n    }\n  }\n": typeof types.GalleryItemCardDataFragmentDoc,
    "\n  fragment GalleryNoteCardData on NoteType {\n    id\n    title\n    content\n  }\n": typeof types.GalleryNoteCardDataFragmentDoc,
    "\n  fragment GalleryPersonCardData on PersonType {\n    id\n    name\n    description\n  }\n": typeof types.GalleryPersonCardDataFragmentDoc,
    "\n  fragment GalleryPlaceCardData on PlaceType {\n    id\n    name\n    description\n  }\n": typeof types.GalleryPlaceCardDataFragmentDoc,
    "\n  fragment GalleryThreadCardData on ThreadType {\n    id\n    name\n    description\n  }\n": typeof types.GalleryThreadCardDataFragmentDoc,
    "\n  fragment TableAnswerRowData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": typeof types.TableAnswerRowDataFragmentDoc,
    "\n  fragment TableBrowserActivityRowData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": typeof types.TableBrowserActivityRowDataFragmentDoc,
    "\n  fragment TableCommunicationRowData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": typeof types.TableCommunicationRowDataFragmentDoc,
    "\n  fragment TableConceptRowData on ConceptType {\n    id\n    name\n    description\n  }\n": typeof types.TableConceptRowDataFragmentDoc,
    "\n  fragment TableContentRowData on ContentType {\n    id\n    title\n    text\n  }\n": typeof types.TableContentRowDataFragmentDoc,
    "\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n  }\n": typeof types.TableEventRowDataFragmentDoc,
    "\n  fragment TableFileRowData on FileType {\n    id\n    url\n  }\n": typeof types.TableFileRowDataFragmentDoc,
    "\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      url\n    }\n  }\n": typeof types.TableItemRowDataFragmentDoc,
    "\n  fragment TableNoteRowData on NoteType {\n    id\n    title\n    content\n  }\n": typeof types.TableNoteRowDataFragmentDoc,
    "\n  fragment TablePersonRowData on PersonType {\n    id\n    name\n    description\n  }\n": typeof types.TablePersonRowDataFragmentDoc,
    "\n  fragment TablePlaceRowData on PlaceType {\n    id\n    name\n    description\n  }\n": typeof types.TablePlaceRowDataFragmentDoc,
    "\n  fragment TableThreadRowData on ThreadType {\n    id\n    name\n    description\n  }\n": typeof types.TableThreadRowDataFragmentDoc,
    "\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...GalleryAnswerCardData\n          ...GalleryBrowserActivityCardData\n          ...GalleryCommunicationCardData\n          ...GalleryConceptCardData\n          ...GalleryContentCardData\n          ...GalleryEventCardData\n          ...GalleryFileCardData\n          ...GalleryNoteCardData\n          ...GalleryItemCardData\n          ...GalleryPersonCardData\n          ...GalleryPlaceCardData\n          ...GalleryThreadCardData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n        }\n      }\n    }\n  }\n": typeof types.SearchDocument,
    "\n  query GetNote($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      content\n      updatedAt\n    }\n  }\n": typeof types.GetNoteDocument,
    "\n  mutation UpdateNote($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": typeof types.UpdateNoteDocument,
    "\n  mutation CreateNote($input: CreateNoteInput!) {\n    createNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": typeof types.CreateNoteDocument,
    "\n                  fragment NewNote on NoteType {\n                    id\n                    title\n                    content\n                    updatedAt\n                  }\n                ": typeof types.NewNoteFragmentDoc,
    "\n  mutation DeleteNote($input: DeleteByIdInput!) {\n    deleteNote(input: $input) {\n      success\n      deletedId\n    }\n  }\n": typeof types.DeleteNoteDocument,
    "\n  fragment NoteGridItemFragment on NoteType {\n    id\n    title\n    content\n  }\n": typeof types.NoteGridItemFragmentFragmentDoc,
    "\n  query GetNotes($first: Int, $after: String) {\n    notes(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...NoteGridItemFragment\n        }\n      }\n    }\n  }\n": typeof types.GetNotesDocument,
    "\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n": typeof types.GetPersonDocument,
    "\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        label\n      }\n    }\n  }\n": typeof types.GetPlaceDocument,
    "\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n": typeof types.ProviderEndpointsFragmentFragmentDoc,
    "\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n": typeof types.GetProviderDocument,
    "\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n": typeof types.DeleteSavedSearchDocument,
    "\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n": typeof types.UpdateSavedSearchDocument,
    "\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n  }\n": typeof types.SavedSearchGridItemFragmentFragmentDoc,
    "\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n": typeof types.GetSavedSearchesDocument,
};
const documents: Documents = {
    "\n  query GetActions {\n    actions {\n      edges {\n        node {\n          id\n          title\n          text\n          imageUrl\n          thread {\n            id\n          }\n          tags {\n            label\n          }\n        }\n      }\n    }\n  }\n": types.GetActionsDocument,
    "\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      tags {\n        label\n      }\n      ... on Node {\n        id\n      }\n    }\n  }\n": types.TagEntitiesDocument,
    "\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      tags {\n        label\n      }\n      ... on Node {\n        id\n      }\n    }\n  }\n": types.UntagEntitiesDocument,
    "\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        label\n      }\n    }\n  }\n": types.GetCommunicationDocument,
    "\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n": types.GetConceptDocument,
    "\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        label\n      }\n    }\n  }\n": types.GetContentDocument,
    "\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n": types.GetEventDocument,
    "\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          periodStart\n          periodEnd\n          summaryText\n          keyInsights\n          notableEvents\n          anomalies\n          tags\n          activityCounts {\n            total\n            browserActivity\n            communications\n            files\n          }\n          dailyRhythm\n          productivityPatterns\n          socialInteractions\n          keyAccomplishments\n          moodIndicators\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n": types.GetSummariesDocument,
    "\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n": types.GetSummaryDocument,
    "\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    originalName\n    contentType\n    url\n    createdAt\n  }\n": types.FileGridItemFragmentFragmentDoc,
    "\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n": types.GetFilesDocument,
    "\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            url\n          }\n        }\n      }\n    }\n  }\n": types.GetInventoryItemsDocument,
    "\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n": types.GetItemDocument,
    "\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n": types.CreateSavedSearchDocument,
    "\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n    }\n  }\n": types.GetSavedSearchDocument,
    "\n  fragment GalleryAnswerCardData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": types.GalleryAnswerCardDataFragmentDoc,
    "\n  fragment GalleryBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": types.GalleryBrowserActivityCardDataFragmentDoc,
    "\n  fragment GalleryCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": types.GalleryCommunicationCardDataFragmentDoc,
    "\n  fragment GalleryConceptCardData on ConceptType {\n    id\n    name\n    description\n  }\n": types.GalleryConceptCardDataFragmentDoc,
    "\n  fragment GalleryContentCardData on ContentType {\n    id\n    title\n    text\n  }\n": types.GalleryContentCardDataFragmentDoc,
    "\n  fragment GalleryEventCardData on EventType {\n    id\n    title\n    description\n  }\n": types.GalleryEventCardDataFragmentDoc,
    "\n  fragment GalleryFileCardData on FileType {\n    id\n    url\n  }\n": types.GalleryFileCardDataFragmentDoc,
    "\n  fragment GalleryItemCardData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      url\n    }\n  }\n": types.GalleryItemCardDataFragmentDoc,
    "\n  fragment GalleryNoteCardData on NoteType {\n    id\n    title\n    content\n  }\n": types.GalleryNoteCardDataFragmentDoc,
    "\n  fragment GalleryPersonCardData on PersonType {\n    id\n    name\n    description\n  }\n": types.GalleryPersonCardDataFragmentDoc,
    "\n  fragment GalleryPlaceCardData on PlaceType {\n    id\n    name\n    description\n  }\n": types.GalleryPlaceCardDataFragmentDoc,
    "\n  fragment GalleryThreadCardData on ThreadType {\n    id\n    name\n    description\n  }\n": types.GalleryThreadCardDataFragmentDoc,
    "\n  fragment TableAnswerRowData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": types.TableAnswerRowDataFragmentDoc,
    "\n  fragment TableBrowserActivityRowData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": types.TableBrowserActivityRowDataFragmentDoc,
    "\n  fragment TableCommunicationRowData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": types.TableCommunicationRowDataFragmentDoc,
    "\n  fragment TableConceptRowData on ConceptType {\n    id\n    name\n    description\n  }\n": types.TableConceptRowDataFragmentDoc,
    "\n  fragment TableContentRowData on ContentType {\n    id\n    title\n    text\n  }\n": types.TableContentRowDataFragmentDoc,
    "\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n  }\n": types.TableEventRowDataFragmentDoc,
    "\n  fragment TableFileRowData on FileType {\n    id\n    url\n  }\n": types.TableFileRowDataFragmentDoc,
    "\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      url\n    }\n  }\n": types.TableItemRowDataFragmentDoc,
    "\n  fragment TableNoteRowData on NoteType {\n    id\n    title\n    content\n  }\n": types.TableNoteRowDataFragmentDoc,
    "\n  fragment TablePersonRowData on PersonType {\n    id\n    name\n    description\n  }\n": types.TablePersonRowDataFragmentDoc,
    "\n  fragment TablePlaceRowData on PlaceType {\n    id\n    name\n    description\n  }\n": types.TablePlaceRowDataFragmentDoc,
    "\n  fragment TableThreadRowData on ThreadType {\n    id\n    name\n    description\n  }\n": types.TableThreadRowDataFragmentDoc,
    "\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...GalleryAnswerCardData\n          ...GalleryBrowserActivityCardData\n          ...GalleryCommunicationCardData\n          ...GalleryConceptCardData\n          ...GalleryContentCardData\n          ...GalleryEventCardData\n          ...GalleryFileCardData\n          ...GalleryNoteCardData\n          ...GalleryItemCardData\n          ...GalleryPersonCardData\n          ...GalleryPlaceCardData\n          ...GalleryThreadCardData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n        }\n      }\n    }\n  }\n": types.SearchDocument,
    "\n  query GetNote($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      content\n      updatedAt\n    }\n  }\n": types.GetNoteDocument,
    "\n  mutation UpdateNote($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": types.UpdateNoteDocument,
    "\n  mutation CreateNote($input: CreateNoteInput!) {\n    createNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": types.CreateNoteDocument,
    "\n                  fragment NewNote on NoteType {\n                    id\n                    title\n                    content\n                    updatedAt\n                  }\n                ": types.NewNoteFragmentDoc,
    "\n  mutation DeleteNote($input: DeleteByIdInput!) {\n    deleteNote(input: $input) {\n      success\n      deletedId\n    }\n  }\n": types.DeleteNoteDocument,
    "\n  fragment NoteGridItemFragment on NoteType {\n    id\n    title\n    content\n  }\n": types.NoteGridItemFragmentFragmentDoc,
    "\n  query GetNotes($first: Int, $after: String) {\n    notes(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...NoteGridItemFragment\n        }\n      }\n    }\n  }\n": types.GetNotesDocument,
    "\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n": types.GetPersonDocument,
    "\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        label\n      }\n    }\n  }\n": types.GetPlaceDocument,
    "\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n": types.ProviderEndpointsFragmentFragmentDoc,
    "\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n": types.GetProviderDocument,
    "\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n": types.DeleteSavedSearchDocument,
    "\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n": types.UpdateSavedSearchDocument,
    "\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n  }\n": types.SavedSearchGridItemFragmentFragmentDoc,
    "\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n": types.GetSavedSearchesDocument,
};

/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 *
 *
 * @example
 * ```ts
 * const query = gql(`query GetUser($id: ID!) { user(id: $id) { name } }`);
 * ```
 *
 * The query argument is unknown!
 * Please regenerate the types.
 */
export function gql(source: string): unknown;

/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetActions {\n    actions {\n      edges {\n        node {\n          id\n          title\n          text\n          imageUrl\n          thread {\n            id\n          }\n          tags {\n            label\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetActions {\n    actions {\n      edges {\n        node {\n          id\n          title\n          text\n          imageUrl\n          thread {\n            id\n          }\n          tags {\n            label\n          }\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      tags {\n        label\n      }\n      ... on Node {\n        id\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      tags {\n        label\n      }\n      ... on Node {\n        id\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      tags {\n        label\n      }\n      ... on Node {\n        id\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      tags {\n        label\n      }\n      ... on Node {\n        id\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          periodStart\n          periodEnd\n          summaryText\n          keyInsights\n          notableEvents\n          anomalies\n          tags\n          activityCounts {\n            total\n            browserActivity\n            communications\n            files\n          }\n          dailyRhythm\n          productivityPatterns\n          socialInteractions\n          keyAccomplishments\n          moodIndicators\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n"): (typeof documents)["\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          periodStart\n          periodEnd\n          summaryText\n          keyInsights\n          notableEvents\n          anomalies\n          tags\n          activityCounts {\n            total\n            browserActivity\n            communications\n            files\n          }\n          dailyRhythm\n          productivityPatterns\n          socialInteractions\n          keyAccomplishments\n          moodIndicators\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n"): (typeof documents)["\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    originalName\n    contentType\n    url\n    createdAt\n  }\n"): (typeof documents)["\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    originalName\n    contentType\n    url\n    createdAt\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            url\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            url\n          }\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n    }\n  }\n"): (typeof documents)["\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryAnswerCardData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n"): (typeof documents)["\n  fragment GalleryAnswerCardData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n  }\n"): (typeof documents)["\n  fragment GalleryBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n  }\n"): (typeof documents)["\n  fragment GalleryCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryConceptCardData on ConceptType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment GalleryConceptCardData on ConceptType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryContentCardData on ContentType {\n    id\n    title\n    text\n  }\n"): (typeof documents)["\n  fragment GalleryContentCardData on ContentType {\n    id\n    title\n    text\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryEventCardData on EventType {\n    id\n    title\n    description\n  }\n"): (typeof documents)["\n  fragment GalleryEventCardData on EventType {\n    id\n    title\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryFileCardData on FileType {\n    id\n    url\n  }\n"): (typeof documents)["\n  fragment GalleryFileCardData on FileType {\n    id\n    url\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryItemCardData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      url\n    }\n  }\n"): (typeof documents)["\n  fragment GalleryItemCardData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      url\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryNoteCardData on NoteType {\n    id\n    title\n    content\n  }\n"): (typeof documents)["\n  fragment GalleryNoteCardData on NoteType {\n    id\n    title\n    content\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryPersonCardData on PersonType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment GalleryPersonCardData on PersonType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryPlaceCardData on PlaceType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment GalleryPlaceCardData on PlaceType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment GalleryThreadCardData on ThreadType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment GalleryThreadCardData on ThreadType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableAnswerRowData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n"): (typeof documents)["\n  fragment TableAnswerRowData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableBrowserActivityRowData on BrowserActivityType {\n    id\n    title\n    url\n  }\n"): (typeof documents)["\n  fragment TableBrowserActivityRowData on BrowserActivityType {\n    id\n    title\n    url\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableCommunicationRowData on CommunicationType {\n    id\n    subject\n    preview\n  }\n"): (typeof documents)["\n  fragment TableCommunicationRowData on CommunicationType {\n    id\n    subject\n    preview\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableConceptRowData on ConceptType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment TableConceptRowData on ConceptType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableContentRowData on ContentType {\n    id\n    title\n    text\n  }\n"): (typeof documents)["\n  fragment TableContentRowData on ContentType {\n    id\n    title\n    text\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n  }\n"): (typeof documents)["\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableFileRowData on FileType {\n    id\n    url\n  }\n"): (typeof documents)["\n  fragment TableFileRowData on FileType {\n    id\n    url\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      url\n    }\n  }\n"): (typeof documents)["\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      url\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableNoteRowData on NoteType {\n    id\n    title\n    content\n  }\n"): (typeof documents)["\n  fragment TableNoteRowData on NoteType {\n    id\n    title\n    content\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TablePersonRowData on PersonType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment TablePersonRowData on PersonType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TablePlaceRowData on PlaceType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment TablePlaceRowData on PlaceType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableThreadRowData on ThreadType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment TableThreadRowData on ThreadType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...GalleryAnswerCardData\n          ...GalleryBrowserActivityCardData\n          ...GalleryCommunicationCardData\n          ...GalleryConceptCardData\n          ...GalleryContentCardData\n          ...GalleryEventCardData\n          ...GalleryFileCardData\n          ...GalleryNoteCardData\n          ...GalleryItemCardData\n          ...GalleryPersonCardData\n          ...GalleryPlaceCardData\n          ...GalleryThreadCardData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...GalleryAnswerCardData\n          ...GalleryBrowserActivityCardData\n          ...GalleryCommunicationCardData\n          ...GalleryConceptCardData\n          ...GalleryContentCardData\n          ...GalleryEventCardData\n          ...GalleryFileCardData\n          ...GalleryNoteCardData\n          ...GalleryItemCardData\n          ...GalleryPersonCardData\n          ...GalleryPlaceCardData\n          ...GalleryThreadCardData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetNote($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      content\n      updatedAt\n    }\n  }\n"): (typeof documents)["\n  query GetNote($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      content\n      updatedAt\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateNote($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateNote($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation CreateNote($input: CreateNoteInput!) {\n    createNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation CreateNote($input: CreateNoteInput!) {\n    createNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n                  fragment NewNote on NoteType {\n                    id\n                    title\n                    content\n                    updatedAt\n                  }\n                "): (typeof documents)["\n                  fragment NewNote on NoteType {\n                    id\n                    title\n                    content\n                    updatedAt\n                  }\n                "];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation DeleteNote($input: DeleteByIdInput!) {\n    deleteNote(input: $input) {\n      success\n      deletedId\n    }\n  }\n"): (typeof documents)["\n  mutation DeleteNote($input: DeleteByIdInput!) {\n    deleteNote(input: $input) {\n      success\n      deletedId\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment NoteGridItemFragment on NoteType {\n    id\n    title\n    content\n  }\n"): (typeof documents)["\n  fragment NoteGridItemFragment on NoteType {\n    id\n    title\n    content\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetNotes($first: Int, $after: String) {\n    notes(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...NoteGridItemFragment\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetNotes($first: Int, $after: String) {\n    notes(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...NoteGridItemFragment\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n"): (typeof documents)["\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n"): (typeof documents)["\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n"): (typeof documents)["\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n  }\n"): (typeof documents)["\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n"];

export function gql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;