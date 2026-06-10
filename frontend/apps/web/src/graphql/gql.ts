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
    "\n  query GetFeedActions($limit: Int) {\n    feedActions(limit: $limit) {\n      id\n      title\n      text\n      imageUrl\n      priority\n      seen\n      dismissed\n      metadata {\n        seen\n        type\n        context\n        relatedPerson\n      }\n      thread {\n        id\n      }\n    }\n  }\n": typeof types.GetFeedActionsDocument,
    "\n  mutation MarkActionAsSeen($id: ID!) {\n    markActionAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n": typeof types.MarkActionAsSeenDocument,
    "\n  mutation MarkActionAsDismissed($id: ID!) {\n    markActionAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n": typeof types.MarkActionAsDismissedDocument,
    "\n  query GetForecast($horizon: String) {\n    forecast(horizon: $horizon) {\n      horizon\n      generatedAt\n      systemStatus\n      buckets {\n        bucketIndex\n        startTime\n        l0Probs { label probability }\n        l1Probs { label probability }\n        l2Probs { label probability }\n        q10\n        q50\n        q90\n      }\n    }\n  }\n": typeof types.GetForecastDocument,
    "\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n": typeof types.TagEntitiesDocument,
    "\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n": typeof types.UntagEntitiesDocument,
    "\n  mutation TriggerHbpe {\n    triggerHbpe\n  }\n": typeof types.TriggerHbpeDocument,
    "\n  query GetNodeTagsForRelationshipCard($id: ID!) {\n    node(id: $id) {\n      __typename\n      ... on Taggable {\n        tags {\n          label\n        }\n      }\n    }\n  }\n": typeof types.GetNodeTagsForRelationshipCardDocument,
    "\n  fragment ActionGridItemData on ActionType {\n    id\n    actionTitle: title\n    actionText: text\n  }\n": typeof types.ActionGridItemDataFragmentDoc,
    "\n  fragment AnswerGridItemData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": typeof types.AnswerGridItemDataFragmentDoc,
    "\n  fragment BrowserActivityGridItemData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": typeof types.BrowserActivityGridItemDataFragmentDoc,
    "\n  fragment CommunicationGridItemData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": typeof types.CommunicationGridItemDataFragmentDoc,
    "\n  fragment ConceptGridItemData on ConceptType {\n    id\n    name\n    description\n  }\n": typeof types.ConceptGridItemDataFragmentDoc,
    "\n  fragment ContentGridItemData on ContentType {\n    id\n    title\n    text\n  }\n": typeof types.ContentGridItemDataFragmentDoc,
    "\n  fragment EventGridItemData on EventType {\n    id\n    title\n    description\n  }\n": typeof types.EventGridItemDataFragmentDoc,
    "\n  fragment FileGridItemData on FileType {\n    id\n    filename\n    previewUrl\n  }\n": typeof types.FileGridItemDataFragmentDoc,
    "\n  fragment ItemGridItemData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n": typeof types.ItemGridItemDataFragmentDoc,
    "\n  fragment NoteGridItemData on NoteType {\n    id\n    title\n    content\n  }\n": typeof types.NoteGridItemDataFragmentDoc,
    "\n  fragment PersonGridItemData on PersonType {\n    id\n    name\n    description\n  }\n": typeof types.PersonGridItemDataFragmentDoc,
    "\n  fragment PlaceGridItemData on PlaceType {\n    id\n    name\n    description\n  }\n": typeof types.PlaceGridItemDataFragmentDoc,
    "\n  fragment ThreadGridItemData on ThreadType {\n    id\n    name\n    description\n  }\n": typeof types.ThreadGridItemDataFragmentDoc,
    "\n  mutation CreateConcept($input: CreateConceptInput!) {\n    createConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n": typeof types.CreateConceptDocument,
    "\n  mutation CreatePerson($input: CreatePersonInput!) {\n    createPerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n      }\n    }\n  }\n": typeof types.CreatePersonDocument,
    "\n  mutation CreateRelationship($input: CreateRelationshipInput!) {\n    createRelationship(input: $input) {\n      success\n      relationship {\n        id\n        fromNodeId\n        fromNodeType\n        toNodeId\n        toNodeType\n        type\n        properties\n        isBidirectional\n        startDate\n        endDate\n      }\n    }\n  }\n": typeof types.CreateRelationshipDocument,
    "\n  query GetFilePreview($id: ID!) {\n    file(id: $id) {\n      id\n      filename\n      contentType\n      sourceUrl\n      previewUrl\n      createdAt\n    }\n  }\n": typeof types.GetFilePreviewDocument,
    "\n  mutation CreateItem($input: CreateItemInput!) {\n    createItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n": typeof types.CreateItemDocument,
    "\n  mutation UpdateItem($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n": typeof types.UpdateItemDocument,
    "\n                  fragment NewItem on ItemType {\n                    id\n                    name\n                    category\n                    description\n                    brand\n                    model\n                    currentValue\n                  }\n                ": typeof types.NewItemFragmentDoc,
    "\n  fragment SearchResultCommunicationData on CommunicationType {\n    id\n    preview\n    time\n  }\n": typeof types.SearchResultCommunicationDataFragmentDoc,
    "\n  fragment SearchResultConceptData on ConceptType {\n    id\n    name\n  }\n": typeof types.SearchResultConceptDataFragmentDoc,
    "\n  fragment SearchResultContentData on ContentType {\n    id\n    title\n  }\n": typeof types.SearchResultContentDataFragmentDoc,
    "\n  fragment SearchResultEventData on EventType {\n    id\n    title\n    startTime\n  }\n": typeof types.SearchResultEventDataFragmentDoc,
    "\n  fragment SearchResultFileData on FileType {\n    id\n    filename\n    previewUrl\n  }\n": typeof types.SearchResultFileDataFragmentDoc,
    "\n  fragment SearchResultItemData on ItemType {\n    id\n    name\n  }\n": typeof types.SearchResultItemDataFragmentDoc,
    "\n  fragment SearchResultNoteData on NoteType {\n    id\n    title\n  }\n": typeof types.SearchResultNoteDataFragmentDoc,
    "\n  fragment SearchResultPersonData on PersonType {\n    id\n    name\n    description\n  }\n": typeof types.SearchResultPersonDataFragmentDoc,
    "\n  fragment SearchResultPlaceData on PlaceType {\n    id\n    name\n  }\n": typeof types.SearchResultPlaceDataFragmentDoc,
    "\n  fragment SearchResultThreadData on ThreadType {\n    id\n    name\n    description\n  }\n": typeof types.SearchResultThreadDataFragmentDoc,
    "\n  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...SearchResultCommunicationData\n          ...SearchResultConceptData\n          ...SearchResultContentData\n          ...SearchResultEventData\n          ...SearchResultFileData\n          ...SearchResultItemData\n          ...SearchResultNoteData\n          ...SearchResultPersonData\n          ...SearchResultPlaceData\n          ...SearchResultThreadData\n        }\n      }\n    }\n  }\n": typeof types.SearchBoxQueryDocument,
    "\n  query GetUserData {\n    me {\n      id\n      name\n      email\n      onboarded\n\n      entity {\n        id\n      }\n    }\n  }\n": typeof types.GetUserDataDocument,
    "\n  fragment FeedBadgeAction on ActionType {\n    id\n    seen\n    dismissed\n  }\n": typeof types.FeedBadgeActionFragmentDoc,
    "\n  fragment FeedBadgeSummary on SummaryType {\n    id\n    seen\n    dismissed\n  }\n": typeof types.FeedBadgeSummaryFragmentDoc,
    "\n  query GetFeedBadgeCount($actionLimit: Int, $summaryFirst: Int) {\n    feedActions(limit: $actionLimit) {\n      ...FeedBadgeAction\n    }\n    summaries(first: $summaryFirst) {\n      edges {\n        node {\n          ...FeedBadgeSummary\n        }\n      }\n    }\n  }\n  \n  \n": typeof types.GetFeedBadgeCountDocument,
    "\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetCommunicationDocument,
    "\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetConceptDocument,
    "\n  query GetConnectionsLight {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          providerId\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": typeof types.GetConnectionsLightDocument,
    "\n  query GetConnection($id: ID!) {\n    connection(id: $id) {\n      id\n      name\n      active\n      schedule\n      tokenExpiry\n      syncState\n      activeEndpoints\n      providerId\n      needsReauth\n      externalId\n      provider {\n        id\n        name\n        authType\n        endpoints {\n          name\n          description\n          iterationType\n          TTL\n        }\n      }\n    }\n  }\n": typeof types.GetConnectionDocument,
    "\n  mutation UpdateConnection($input: UpdateConnectionInput!) {\n    updateConnection(input: $input) {\n      success\n      connection {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          provider {\n              id\n              name\n              authType\n              endpoints {\n                name\n                description\n                iterationType\n                TTL\n              }\n          }\n      }\n    }\n  }\n": typeof types.UpdateConnectionDocument,
    "\n  mutation DeleteConnection($input: DeleteByIdInput!) {\n    deleteConnection(input: $input) {\n      success\n      deletedId\n    }\n  }\n": typeof types.DeleteConnectionDocument,
    "\n  query GetConnectionSyncJobs($connectionId: ID!, $endpointName: String, $type: String, $first: Int) {\n    connectionSyncJobs(connectionId: $connectionId, endpointName: $endpointName, type: $type, first: $first) {\n      edges {\n        cursor\n        node {\n          id\n          cursor\n          endpointName\n          nextCursor\n          connectionId\n          status\n          type\n          createdAt\n          updatedAt\n          completedAt\n          error\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": typeof types.GetConnectionSyncJobsDocument,
    "\n  query GetConnections {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          provider {\n            id\n            name\n            localOnly\n            endpoints {\n              name\n              description\n            }\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": typeof types.GetConnectionsDocument,
    "\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetContentDocument,
    "\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        id\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetEventDocument,
    "\n  fragment InsightCardData on InsightItemType {\n    title\n    summaryText\n    keyActions\n    relevanceScore\n    tags\n    relatedEntityIds\n  }\n": typeof types.InsightCardDataFragmentDoc,
    "\n  fragment SummaryCardData on SummaryType {\n    id\n    title\n    periodType\n    seen\n    summaryText\n    keyInsights\n    tags\n    activityCounts {\n      total\n    }\n  }\n": typeof types.SummaryCardDataFragmentDoc,
    "\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          seen\n          dismissed\n          summaryText\n          keyInsights\n          tags\n          activityCounts {\n            total\n          }\n          insights {\n            title\n            summaryText\n            keyActions\n            relevanceScore\n            tags\n            relatedEntityIds\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n": typeof types.GetSummariesDocument,
    "\n  mutation MarkSummaryAsSeen($id: ID!) {\n    markSummaryAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n": typeof types.MarkSummaryAsSeenDocument,
    "\n  mutation MarkSummaryAsDismissed($id: ID!) {\n    markSummaryAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n": typeof types.MarkSummaryAsDismissedDocument,
    "\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n": typeof types.GetFilesDocument,
    "\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    previewUrl\n  }\n": typeof types.FileGridItemFragmentFragmentDoc,
    "\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            sourceUrl\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetInventoryItemsDocument,
    "\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetItemDocument,
    "\n  fragment TimelineBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n    actionType\n    duration\n    time\n  }\n": typeof types.TimelineBrowserActivityCardDataFragmentDoc,
    "\n  fragment TimelineCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n    communicationContent: content\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n    to {\n      edges {\n        node {\n          id\n          name\n        }\n      }\n    }\n  }\n": typeof types.TimelineCommunicationCardDataFragmentDoc,
    "\n  fragment TimelineEventCardData on EventType {\n    id\n    title\n    description\n    startTime\n    endTime\n    location {\n      ... on PlaceType {\n        id\n        name\n        properties\n      }\n    }\n  }\n": typeof types.TimelineEventCardDataFragmentDoc,
    "\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n": typeof types.CreateSavedSearchDocument,
    "\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n    }\n  }\n": typeof types.GetSavedSearchDocument,
    "\n  fragment TableAnswerRowData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": typeof types.TableAnswerRowDataFragmentDoc,
    "\n  fragment TableBrowserActivityRowData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": typeof types.TableBrowserActivityRowDataFragmentDoc,
    "\n  fragment TableCommunicationRowData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": typeof types.TableCommunicationRowDataFragmentDoc,
    "\n  fragment TableConceptRowData on ConceptType {\n    id\n    name\n    description\n  }\n": typeof types.TableConceptRowDataFragmentDoc,
    "\n  fragment TableContentRowData on ContentType {\n    id\n    title\n    text\n  }\n": typeof types.TableContentRowDataFragmentDoc,
    "\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n  }\n": typeof types.TableEventRowDataFragmentDoc,
    "\n  fragment TableFileRowData on FileType {\n    id\n    filename\n    title\n    previewUrl\n    contentType\n  }\n": typeof types.TableFileRowDataFragmentDoc,
    "\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n": typeof types.TableItemRowDataFragmentDoc,
    "\n  fragment TableNoteRowData on NoteType {\n    id\n    title\n    content\n  }\n": typeof types.TableNoteRowDataFragmentDoc,
    "\n  fragment TablePersonRowData on PersonType {\n    id\n    name\n    description\n  }\n": typeof types.TablePersonRowDataFragmentDoc,
    "\n  fragment TablePlaceRowData on PlaceType {\n    id\n    name\n    description\n  }\n": typeof types.TablePlaceRowDataFragmentDoc,
    "\n  fragment TableThreadRowData on ThreadType {\n    id\n    name\n    description\n  }\n": typeof types.TableThreadRowDataFragmentDoc,
    "\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...AnswerGridItemData\n          ...BrowserActivityGridItemData\n          ...CommunicationGridItemData\n          ...ConceptGridItemData\n          ...ContentGridItemData\n          ...EventGridItemData\n          ...FileGridItemData\n          ...NoteGridItemData\n          ...ItemGridItemData\n          ...PersonGridItemData\n          ...PlaceGridItemData\n          ...ThreadGridItemData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n\n          ...TimelineBrowserActivityCardData\n          ...TimelineCommunicationCardData\n          ...TimelineEventCardData\n        }\n      }\n    }\n  }\n": typeof types.SearchDocument,
    "\n  query GetNote($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      content\n      updatedAt\n    }\n  }\n": typeof types.GetNoteDocument,
    "\n  mutation UpdateNote($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": typeof types.UpdateNoteDocument,
    "\n  mutation CreateNote($input: CreateNoteInput!) {\n    createNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": typeof types.CreateNoteDocument,
    "\n                  fragment NewNote on NoteType {\n                    id\n                    title\n                    content\n                    updatedAt\n                  }\n                ": typeof types.NewNoteFragmentDoc,
    "\n  mutation DeleteNote($input: DeleteByIdInput!) {\n    deleteNote(input: $input) {\n      success\n      deletedId\n    }\n  }\n": typeof types.DeleteNoteDocument,
    "\n  fragment NoteGridItemFragment on NoteType {\n    id\n    title\n    content\n  }\n": typeof types.NoteGridItemFragmentFragmentDoc,
    "\n  query GetNotes($first: Int, $after: String) {\n    notes(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...NoteGridItemFragment\n        }\n      }\n    }\n  }\n": typeof types.GetNotesDocument,
    "\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetPersonDocument,
    "\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetPlaceDocument,
    "\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n": typeof types.ProviderEndpointsFragmentFragmentDoc,
    "\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      authType\n      localOnly\n      appSetupUrl\n      openidKeyLink\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n": typeof types.GetProviderDocument,
    "\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n": typeof types.DeleteSavedSearchDocument,
    "\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n": typeof types.UpdateSavedSearchDocument,
    "\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n  }\n": typeof types.SavedSearchGridItemFragmentFragmentDoc,
    "\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n": typeof types.GetSavedSearchesDocument,
    "\n  mutation CreateProviderKey($input: CreateProviderKeyInput!) {\n    createProviderKey(input: $input) {\n      id\n      providerId\n      clientId\n      clientSecret\n      userId\n    }\n  }\n": typeof types.CreateProviderKeyDocument,
    "\n  mutation UpdateProviderKey($id: ID!, $input: UpdateProviderKeyInput!) {\n    updateProviderKey(id: $id, input: $input) {\n      id\n      clientId\n      clientSecret\n    }\n  }\n": typeof types.UpdateProviderKeyDocument,
    "\n  mutation DeleteProviderKey($id: ID!) {\n    deleteProviderKey(id: $id)\n  }\n": typeof types.DeleteProviderKeyDocument,
    "\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n": typeof types.GetSummaryDocument,
    "\n  query GetTag($id: ID!) {\n    tag(id: $id) {\n      id\n      label\n      description\n\n      entities {\n        edges {\n          node {\n            __typename\n\n            ... on Node {\n              id\n            }\n\n            ...ActionGridItemData\n            ...BrowserActivityGridItemData\n            ...CommunicationGridItemData\n            ...ConceptGridItemData\n            ...ContentGridItemData\n            ...EventGridItemData\n            ...FileGridItemData\n            ...NoteGridItemData\n            ...ItemGridItemData\n            ...PersonGridItemData\n            ...PlaceGridItemData\n            ...ThreadGridItemData\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetTagDocument,
    "\n  query GetTags {\n    tags {\n      edges {\n        node {\n          id\n          label\n          description\n        }\n      }\n    }\n  }\n": typeof types.GetTagsDocument,
    "\n  query GetOAuthCallbackUrl {\n    oAuthCallbackUrl\n  }\n": typeof types.GetOAuthCallbackUrlDocument,
    "\n  query GetProviders {\n    providers {\n      edges {\n        cursor\n        node {\n          id\n          name\n          description\n          logoUrl\n          localOnly\n          appSetupUrl\n          authType\n          scopes\n          providerKeys {\n            id\n            clientId\n            clientSecret\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetProvidersDocument,
};
const documents: Documents = {
    "\n  query GetFeedActions($limit: Int) {\n    feedActions(limit: $limit) {\n      id\n      title\n      text\n      imageUrl\n      priority\n      seen\n      dismissed\n      metadata {\n        seen\n        type\n        context\n        relatedPerson\n      }\n      thread {\n        id\n      }\n    }\n  }\n": types.GetFeedActionsDocument,
    "\n  mutation MarkActionAsSeen($id: ID!) {\n    markActionAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n": types.MarkActionAsSeenDocument,
    "\n  mutation MarkActionAsDismissed($id: ID!) {\n    markActionAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n": types.MarkActionAsDismissedDocument,
    "\n  query GetForecast($horizon: String) {\n    forecast(horizon: $horizon) {\n      horizon\n      generatedAt\n      systemStatus\n      buckets {\n        bucketIndex\n        startTime\n        l0Probs { label probability }\n        l1Probs { label probability }\n        l2Probs { label probability }\n        q10\n        q50\n        q90\n      }\n    }\n  }\n": types.GetForecastDocument,
    "\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n": types.TagEntitiesDocument,
    "\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n": types.UntagEntitiesDocument,
    "\n  mutation TriggerHbpe {\n    triggerHbpe\n  }\n": types.TriggerHbpeDocument,
    "\n  query GetNodeTagsForRelationshipCard($id: ID!) {\n    node(id: $id) {\n      __typename\n      ... on Taggable {\n        tags {\n          label\n        }\n      }\n    }\n  }\n": types.GetNodeTagsForRelationshipCardDocument,
    "\n  fragment ActionGridItemData on ActionType {\n    id\n    actionTitle: title\n    actionText: text\n  }\n": types.ActionGridItemDataFragmentDoc,
    "\n  fragment AnswerGridItemData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": types.AnswerGridItemDataFragmentDoc,
    "\n  fragment BrowserActivityGridItemData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": types.BrowserActivityGridItemDataFragmentDoc,
    "\n  fragment CommunicationGridItemData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": types.CommunicationGridItemDataFragmentDoc,
    "\n  fragment ConceptGridItemData on ConceptType {\n    id\n    name\n    description\n  }\n": types.ConceptGridItemDataFragmentDoc,
    "\n  fragment ContentGridItemData on ContentType {\n    id\n    title\n    text\n  }\n": types.ContentGridItemDataFragmentDoc,
    "\n  fragment EventGridItemData on EventType {\n    id\n    title\n    description\n  }\n": types.EventGridItemDataFragmentDoc,
    "\n  fragment FileGridItemData on FileType {\n    id\n    filename\n    previewUrl\n  }\n": types.FileGridItemDataFragmentDoc,
    "\n  fragment ItemGridItemData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n": types.ItemGridItemDataFragmentDoc,
    "\n  fragment NoteGridItemData on NoteType {\n    id\n    title\n    content\n  }\n": types.NoteGridItemDataFragmentDoc,
    "\n  fragment PersonGridItemData on PersonType {\n    id\n    name\n    description\n  }\n": types.PersonGridItemDataFragmentDoc,
    "\n  fragment PlaceGridItemData on PlaceType {\n    id\n    name\n    description\n  }\n": types.PlaceGridItemDataFragmentDoc,
    "\n  fragment ThreadGridItemData on ThreadType {\n    id\n    name\n    description\n  }\n": types.ThreadGridItemDataFragmentDoc,
    "\n  mutation CreateConcept($input: CreateConceptInput!) {\n    createConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n": types.CreateConceptDocument,
    "\n  mutation CreatePerson($input: CreatePersonInput!) {\n    createPerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n      }\n    }\n  }\n": types.CreatePersonDocument,
    "\n  mutation CreateRelationship($input: CreateRelationshipInput!) {\n    createRelationship(input: $input) {\n      success\n      relationship {\n        id\n        fromNodeId\n        fromNodeType\n        toNodeId\n        toNodeType\n        type\n        properties\n        isBidirectional\n        startDate\n        endDate\n      }\n    }\n  }\n": types.CreateRelationshipDocument,
    "\n  query GetFilePreview($id: ID!) {\n    file(id: $id) {\n      id\n      filename\n      contentType\n      sourceUrl\n      previewUrl\n      createdAt\n    }\n  }\n": types.GetFilePreviewDocument,
    "\n  mutation CreateItem($input: CreateItemInput!) {\n    createItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n": types.CreateItemDocument,
    "\n  mutation UpdateItem($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n": types.UpdateItemDocument,
    "\n                  fragment NewItem on ItemType {\n                    id\n                    name\n                    category\n                    description\n                    brand\n                    model\n                    currentValue\n                  }\n                ": types.NewItemFragmentDoc,
    "\n  fragment SearchResultCommunicationData on CommunicationType {\n    id\n    preview\n    time\n  }\n": types.SearchResultCommunicationDataFragmentDoc,
    "\n  fragment SearchResultConceptData on ConceptType {\n    id\n    name\n  }\n": types.SearchResultConceptDataFragmentDoc,
    "\n  fragment SearchResultContentData on ContentType {\n    id\n    title\n  }\n": types.SearchResultContentDataFragmentDoc,
    "\n  fragment SearchResultEventData on EventType {\n    id\n    title\n    startTime\n  }\n": types.SearchResultEventDataFragmentDoc,
    "\n  fragment SearchResultFileData on FileType {\n    id\n    filename\n    previewUrl\n  }\n": types.SearchResultFileDataFragmentDoc,
    "\n  fragment SearchResultItemData on ItemType {\n    id\n    name\n  }\n": types.SearchResultItemDataFragmentDoc,
    "\n  fragment SearchResultNoteData on NoteType {\n    id\n    title\n  }\n": types.SearchResultNoteDataFragmentDoc,
    "\n  fragment SearchResultPersonData on PersonType {\n    id\n    name\n    description\n  }\n": types.SearchResultPersonDataFragmentDoc,
    "\n  fragment SearchResultPlaceData on PlaceType {\n    id\n    name\n  }\n": types.SearchResultPlaceDataFragmentDoc,
    "\n  fragment SearchResultThreadData on ThreadType {\n    id\n    name\n    description\n  }\n": types.SearchResultThreadDataFragmentDoc,
    "\n  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...SearchResultCommunicationData\n          ...SearchResultConceptData\n          ...SearchResultContentData\n          ...SearchResultEventData\n          ...SearchResultFileData\n          ...SearchResultItemData\n          ...SearchResultNoteData\n          ...SearchResultPersonData\n          ...SearchResultPlaceData\n          ...SearchResultThreadData\n        }\n      }\n    }\n  }\n": types.SearchBoxQueryDocument,
    "\n  query GetUserData {\n    me {\n      id\n      name\n      email\n      onboarded\n\n      entity {\n        id\n      }\n    }\n  }\n": types.GetUserDataDocument,
    "\n  fragment FeedBadgeAction on ActionType {\n    id\n    seen\n    dismissed\n  }\n": types.FeedBadgeActionFragmentDoc,
    "\n  fragment FeedBadgeSummary on SummaryType {\n    id\n    seen\n    dismissed\n  }\n": types.FeedBadgeSummaryFragmentDoc,
    "\n  query GetFeedBadgeCount($actionLimit: Int, $summaryFirst: Int) {\n    feedActions(limit: $actionLimit) {\n      ...FeedBadgeAction\n    }\n    summaries(first: $summaryFirst) {\n      edges {\n        node {\n          ...FeedBadgeSummary\n        }\n      }\n    }\n  }\n  \n  \n": types.GetFeedBadgeCountDocument,
    "\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetCommunicationDocument,
    "\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetConceptDocument,
    "\n  query GetConnectionsLight {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          providerId\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": types.GetConnectionsLightDocument,
    "\n  query GetConnection($id: ID!) {\n    connection(id: $id) {\n      id\n      name\n      active\n      schedule\n      tokenExpiry\n      syncState\n      activeEndpoints\n      providerId\n      needsReauth\n      externalId\n      provider {\n        id\n        name\n        authType\n        endpoints {\n          name\n          description\n          iterationType\n          TTL\n        }\n      }\n    }\n  }\n": types.GetConnectionDocument,
    "\n  mutation UpdateConnection($input: UpdateConnectionInput!) {\n    updateConnection(input: $input) {\n      success\n      connection {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          provider {\n              id\n              name\n              authType\n              endpoints {\n                name\n                description\n                iterationType\n                TTL\n              }\n          }\n      }\n    }\n  }\n": types.UpdateConnectionDocument,
    "\n  mutation DeleteConnection($input: DeleteByIdInput!) {\n    deleteConnection(input: $input) {\n      success\n      deletedId\n    }\n  }\n": types.DeleteConnectionDocument,
    "\n  query GetConnectionSyncJobs($connectionId: ID!, $endpointName: String, $type: String, $first: Int) {\n    connectionSyncJobs(connectionId: $connectionId, endpointName: $endpointName, type: $type, first: $first) {\n      edges {\n        cursor\n        node {\n          id\n          cursor\n          endpointName\n          nextCursor\n          connectionId\n          status\n          type\n          createdAt\n          updatedAt\n          completedAt\n          error\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": types.GetConnectionSyncJobsDocument,
    "\n  query GetConnections {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          provider {\n            id\n            name\n            localOnly\n            endpoints {\n              name\n              description\n            }\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": types.GetConnectionsDocument,
    "\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetContentDocument,
    "\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        id\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n": types.GetEventDocument,
    "\n  fragment InsightCardData on InsightItemType {\n    title\n    summaryText\n    keyActions\n    relevanceScore\n    tags\n    relatedEntityIds\n  }\n": types.InsightCardDataFragmentDoc,
    "\n  fragment SummaryCardData on SummaryType {\n    id\n    title\n    periodType\n    seen\n    summaryText\n    keyInsights\n    tags\n    activityCounts {\n      total\n    }\n  }\n": types.SummaryCardDataFragmentDoc,
    "\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          seen\n          dismissed\n          summaryText\n          keyInsights\n          tags\n          activityCounts {\n            total\n          }\n          insights {\n            title\n            summaryText\n            keyActions\n            relevanceScore\n            tags\n            relatedEntityIds\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n": types.GetSummariesDocument,
    "\n  mutation MarkSummaryAsSeen($id: ID!) {\n    markSummaryAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n": types.MarkSummaryAsSeenDocument,
    "\n  mutation MarkSummaryAsDismissed($id: ID!) {\n    markSummaryAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n": types.MarkSummaryAsDismissedDocument,
    "\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n": types.GetFilesDocument,
    "\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    previewUrl\n  }\n": types.FileGridItemFragmentFragmentDoc,
    "\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            sourceUrl\n          }\n        }\n      }\n    }\n  }\n": types.GetInventoryItemsDocument,
    "\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetItemDocument,
    "\n  fragment TimelineBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n    actionType\n    duration\n    time\n  }\n": types.TimelineBrowserActivityCardDataFragmentDoc,
    "\n  fragment TimelineCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n    communicationContent: content\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n    to {\n      edges {\n        node {\n          id\n          name\n        }\n      }\n    }\n  }\n": types.TimelineCommunicationCardDataFragmentDoc,
    "\n  fragment TimelineEventCardData on EventType {\n    id\n    title\n    description\n    startTime\n    endTime\n    location {\n      ... on PlaceType {\n        id\n        name\n        properties\n      }\n    }\n  }\n": types.TimelineEventCardDataFragmentDoc,
    "\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n": types.CreateSavedSearchDocument,
    "\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n    }\n  }\n": types.GetSavedSearchDocument,
    "\n  fragment TableAnswerRowData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": types.TableAnswerRowDataFragmentDoc,
    "\n  fragment TableBrowserActivityRowData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": types.TableBrowserActivityRowDataFragmentDoc,
    "\n  fragment TableCommunicationRowData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": types.TableCommunicationRowDataFragmentDoc,
    "\n  fragment TableConceptRowData on ConceptType {\n    id\n    name\n    description\n  }\n": types.TableConceptRowDataFragmentDoc,
    "\n  fragment TableContentRowData on ContentType {\n    id\n    title\n    text\n  }\n": types.TableContentRowDataFragmentDoc,
    "\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n  }\n": types.TableEventRowDataFragmentDoc,
    "\n  fragment TableFileRowData on FileType {\n    id\n    filename\n    title\n    previewUrl\n    contentType\n  }\n": types.TableFileRowDataFragmentDoc,
    "\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n": types.TableItemRowDataFragmentDoc,
    "\n  fragment TableNoteRowData on NoteType {\n    id\n    title\n    content\n  }\n": types.TableNoteRowDataFragmentDoc,
    "\n  fragment TablePersonRowData on PersonType {\n    id\n    name\n    description\n  }\n": types.TablePersonRowDataFragmentDoc,
    "\n  fragment TablePlaceRowData on PlaceType {\n    id\n    name\n    description\n  }\n": types.TablePlaceRowDataFragmentDoc,
    "\n  fragment TableThreadRowData on ThreadType {\n    id\n    name\n    description\n  }\n": types.TableThreadRowDataFragmentDoc,
    "\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...AnswerGridItemData\n          ...BrowserActivityGridItemData\n          ...CommunicationGridItemData\n          ...ConceptGridItemData\n          ...ContentGridItemData\n          ...EventGridItemData\n          ...FileGridItemData\n          ...NoteGridItemData\n          ...ItemGridItemData\n          ...PersonGridItemData\n          ...PlaceGridItemData\n          ...ThreadGridItemData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n\n          ...TimelineBrowserActivityCardData\n          ...TimelineCommunicationCardData\n          ...TimelineEventCardData\n        }\n      }\n    }\n  }\n": types.SearchDocument,
    "\n  query GetNote($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      content\n      updatedAt\n    }\n  }\n": types.GetNoteDocument,
    "\n  mutation UpdateNote($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": types.UpdateNoteDocument,
    "\n  mutation CreateNote($input: CreateNoteInput!) {\n    createNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": types.CreateNoteDocument,
    "\n                  fragment NewNote on NoteType {\n                    id\n                    title\n                    content\n                    updatedAt\n                  }\n                ": types.NewNoteFragmentDoc,
    "\n  mutation DeleteNote($input: DeleteByIdInput!) {\n    deleteNote(input: $input) {\n      success\n      deletedId\n    }\n  }\n": types.DeleteNoteDocument,
    "\n  fragment NoteGridItemFragment on NoteType {\n    id\n    title\n    content\n  }\n": types.NoteGridItemFragmentFragmentDoc,
    "\n  query GetNotes($first: Int, $after: String) {\n    notes(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...NoteGridItemFragment\n        }\n      }\n    }\n  }\n": types.GetNotesDocument,
    "\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetPersonDocument,
    "\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetPlaceDocument,
    "\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n": types.ProviderEndpointsFragmentFragmentDoc,
    "\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      authType\n      localOnly\n      appSetupUrl\n      openidKeyLink\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n": types.GetProviderDocument,
    "\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n": types.DeleteSavedSearchDocument,
    "\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n      }\n    }\n  }\n": types.UpdateSavedSearchDocument,
    "\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n  }\n": types.SavedSearchGridItemFragmentFragmentDoc,
    "\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n": types.GetSavedSearchesDocument,
    "\n  mutation CreateProviderKey($input: CreateProviderKeyInput!) {\n    createProviderKey(input: $input) {\n      id\n      providerId\n      clientId\n      clientSecret\n      userId\n    }\n  }\n": types.CreateProviderKeyDocument,
    "\n  mutation UpdateProviderKey($id: ID!, $input: UpdateProviderKeyInput!) {\n    updateProviderKey(id: $id, input: $input) {\n      id\n      clientId\n      clientSecret\n    }\n  }\n": types.UpdateProviderKeyDocument,
    "\n  mutation DeleteProviderKey($id: ID!) {\n    deleteProviderKey(id: $id)\n  }\n": types.DeleteProviderKeyDocument,
    "\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n": types.GetSummaryDocument,
    "\n  query GetTag($id: ID!) {\n    tag(id: $id) {\n      id\n      label\n      description\n\n      entities {\n        edges {\n          node {\n            __typename\n\n            ... on Node {\n              id\n            }\n\n            ...ActionGridItemData\n            ...BrowserActivityGridItemData\n            ...CommunicationGridItemData\n            ...ConceptGridItemData\n            ...ContentGridItemData\n            ...EventGridItemData\n            ...FileGridItemData\n            ...NoteGridItemData\n            ...ItemGridItemData\n            ...PersonGridItemData\n            ...PlaceGridItemData\n            ...ThreadGridItemData\n          }\n        }\n      }\n    }\n  }\n": types.GetTagDocument,
    "\n  query GetTags {\n    tags {\n      edges {\n        node {\n          id\n          label\n          description\n        }\n      }\n    }\n  }\n": types.GetTagsDocument,
    "\n  query GetOAuthCallbackUrl {\n    oAuthCallbackUrl\n  }\n": types.GetOAuthCallbackUrlDocument,
    "\n  query GetProviders {\n    providers {\n      edges {\n        cursor\n        node {\n          id\n          name\n          description\n          logoUrl\n          localOnly\n          appSetupUrl\n          authType\n          scopes\n          providerKeys {\n            id\n            clientId\n            clientSecret\n          }\n        }\n      }\n    }\n  }\n": types.GetProvidersDocument,
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
export function gql(source: "\n  query GetFeedActions($limit: Int) {\n    feedActions(limit: $limit) {\n      id\n      title\n      text\n      imageUrl\n      priority\n      seen\n      dismissed\n      metadata {\n        seen\n        type\n        context\n        relatedPerson\n      }\n      thread {\n        id\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetFeedActions($limit: Int) {\n    feedActions(limit: $limit) {\n      id\n      title\n      text\n      imageUrl\n      priority\n      seen\n      dismissed\n      metadata {\n        seen\n        type\n        context\n        relatedPerson\n      }\n      thread {\n        id\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation MarkActionAsSeen($id: ID!) {\n    markActionAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n"): (typeof documents)["\n  mutation MarkActionAsSeen($id: ID!) {\n    markActionAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation MarkActionAsDismissed($id: ID!) {\n    markActionAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n"): (typeof documents)["\n  mutation MarkActionAsDismissed($id: ID!) {\n    markActionAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetForecast($horizon: String) {\n    forecast(horizon: $horizon) {\n      horizon\n      generatedAt\n      systemStatus\n      buckets {\n        bucketIndex\n        startTime\n        l0Probs { label probability }\n        l1Probs { label probability }\n        l2Probs { label probability }\n        q10\n        q50\n        q90\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetForecast($horizon: String) {\n    forecast(horizon: $horizon) {\n      horizon\n      generatedAt\n      systemStatus\n      buckets {\n        bucketIndex\n        startTime\n        l0Probs { label probability }\n        l1Probs { label probability }\n        l2Probs { label probability }\n        q10\n        q50\n        q90\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation TriggerHbpe {\n    triggerHbpe\n  }\n"): (typeof documents)["\n  mutation TriggerHbpe {\n    triggerHbpe\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetNodeTagsForRelationshipCard($id: ID!) {\n    node(id: $id) {\n      __typename\n      ... on Taggable {\n        tags {\n          label\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetNodeTagsForRelationshipCard($id: ID!) {\n    node(id: $id) {\n      __typename\n      ... on Taggable {\n        tags {\n          label\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ActionGridItemData on ActionType {\n    id\n    actionTitle: title\n    actionText: text\n  }\n"): (typeof documents)["\n  fragment ActionGridItemData on ActionType {\n    id\n    actionTitle: title\n    actionText: text\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment AnswerGridItemData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n"): (typeof documents)["\n  fragment AnswerGridItemData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment BrowserActivityGridItemData on BrowserActivityType {\n    id\n    title\n    url\n  }\n"): (typeof documents)["\n  fragment BrowserActivityGridItemData on BrowserActivityType {\n    id\n    title\n    url\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment CommunicationGridItemData on CommunicationType {\n    id\n    subject\n    preview\n  }\n"): (typeof documents)["\n  fragment CommunicationGridItemData on CommunicationType {\n    id\n    subject\n    preview\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ConceptGridItemData on ConceptType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment ConceptGridItemData on ConceptType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ContentGridItemData on ContentType {\n    id\n    title\n    text\n  }\n"): (typeof documents)["\n  fragment ContentGridItemData on ContentType {\n    id\n    title\n    text\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment EventGridItemData on EventType {\n    id\n    title\n    description\n  }\n"): (typeof documents)["\n  fragment EventGridItemData on EventType {\n    id\n    title\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment FileGridItemData on FileType {\n    id\n    filename\n    previewUrl\n  }\n"): (typeof documents)["\n  fragment FileGridItemData on FileType {\n    id\n    filename\n    previewUrl\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ItemGridItemData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n"): (typeof documents)["\n  fragment ItemGridItemData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment NoteGridItemData on NoteType {\n    id\n    title\n    content\n  }\n"): (typeof documents)["\n  fragment NoteGridItemData on NoteType {\n    id\n    title\n    content\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment PersonGridItemData on PersonType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment PersonGridItemData on PersonType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment PlaceGridItemData on PlaceType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment PlaceGridItemData on PlaceType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ThreadGridItemData on ThreadType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment ThreadGridItemData on ThreadType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation CreateConcept($input: CreateConceptInput!) {\n    createConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation CreateConcept($input: CreateConceptInput!) {\n    createConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation CreatePerson($input: CreatePersonInput!) {\n    createPerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation CreatePerson($input: CreatePersonInput!) {\n    createPerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation CreateRelationship($input: CreateRelationshipInput!) {\n    createRelationship(input: $input) {\n      success\n      relationship {\n        id\n        fromNodeId\n        fromNodeType\n        toNodeId\n        toNodeType\n        type\n        properties\n        isBidirectional\n        startDate\n        endDate\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation CreateRelationship($input: CreateRelationshipInput!) {\n    createRelationship(input: $input) {\n      success\n      relationship {\n        id\n        fromNodeId\n        fromNodeType\n        toNodeId\n        toNodeType\n        type\n        properties\n        isBidirectional\n        startDate\n        endDate\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetFilePreview($id: ID!) {\n    file(id: $id) {\n      id\n      filename\n      contentType\n      sourceUrl\n      previewUrl\n      createdAt\n    }\n  }\n"): (typeof documents)["\n  query GetFilePreview($id: ID!) {\n    file(id: $id) {\n      id\n      filename\n      contentType\n      sourceUrl\n      previewUrl\n      createdAt\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation CreateItem($input: CreateItemInput!) {\n    createItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n"): (typeof documents)["\n  mutation CreateItem($input: CreateItemInput!) {\n    createItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateItem($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateItem($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n                  fragment NewItem on ItemType {\n                    id\n                    name\n                    category\n                    description\n                    brand\n                    model\n                    currentValue\n                  }\n                "): (typeof documents)["\n                  fragment NewItem on ItemType {\n                    id\n                    name\n                    category\n                    description\n                    brand\n                    model\n                    currentValue\n                  }\n                "];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultCommunicationData on CommunicationType {\n    id\n    preview\n    time\n  }\n"): (typeof documents)["\n  fragment SearchResultCommunicationData on CommunicationType {\n    id\n    preview\n    time\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultConceptData on ConceptType {\n    id\n    name\n  }\n"): (typeof documents)["\n  fragment SearchResultConceptData on ConceptType {\n    id\n    name\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultContentData on ContentType {\n    id\n    title\n  }\n"): (typeof documents)["\n  fragment SearchResultContentData on ContentType {\n    id\n    title\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultEventData on EventType {\n    id\n    title\n    startTime\n  }\n"): (typeof documents)["\n  fragment SearchResultEventData on EventType {\n    id\n    title\n    startTime\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultFileData on FileType {\n    id\n    filename\n    previewUrl\n  }\n"): (typeof documents)["\n  fragment SearchResultFileData on FileType {\n    id\n    filename\n    previewUrl\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultItemData on ItemType {\n    id\n    name\n  }\n"): (typeof documents)["\n  fragment SearchResultItemData on ItemType {\n    id\n    name\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultNoteData on NoteType {\n    id\n    title\n  }\n"): (typeof documents)["\n  fragment SearchResultNoteData on NoteType {\n    id\n    title\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultPersonData on PersonType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment SearchResultPersonData on PersonType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultPlaceData on PlaceType {\n    id\n    name\n  }\n"): (typeof documents)["\n  fragment SearchResultPlaceData on PlaceType {\n    id\n    name\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SearchResultThreadData on ThreadType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment SearchResultThreadData on ThreadType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...SearchResultCommunicationData\n          ...SearchResultConceptData\n          ...SearchResultContentData\n          ...SearchResultEventData\n          ...SearchResultFileData\n          ...SearchResultItemData\n          ...SearchResultNoteData\n          ...SearchResultPersonData\n          ...SearchResultPlaceData\n          ...SearchResultThreadData\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...SearchResultCommunicationData\n          ...SearchResultConceptData\n          ...SearchResultContentData\n          ...SearchResultEventData\n          ...SearchResultFileData\n          ...SearchResultItemData\n          ...SearchResultNoteData\n          ...SearchResultPersonData\n          ...SearchResultPlaceData\n          ...SearchResultThreadData\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetUserData {\n    me {\n      id\n      name\n      email\n      onboarded\n\n      entity {\n        id\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetUserData {\n    me {\n      id\n      name\n      email\n      onboarded\n\n      entity {\n        id\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment FeedBadgeAction on ActionType {\n    id\n    seen\n    dismissed\n  }\n"): (typeof documents)["\n  fragment FeedBadgeAction on ActionType {\n    id\n    seen\n    dismissed\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment FeedBadgeSummary on SummaryType {\n    id\n    seen\n    dismissed\n  }\n"): (typeof documents)["\n  fragment FeedBadgeSummary on SummaryType {\n    id\n    seen\n    dismissed\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetFeedBadgeCount($actionLimit: Int, $summaryFirst: Int) {\n    feedActions(limit: $actionLimit) {\n      ...FeedBadgeAction\n    }\n    summaries(first: $summaryFirst) {\n      edges {\n        node {\n          ...FeedBadgeSummary\n        }\n      }\n    }\n  }\n  \n  \n"): (typeof documents)["\n  query GetFeedBadgeCount($actionLimit: Int, $summaryFirst: Int) {\n    feedActions(limit: $actionLimit) {\n      ...FeedBadgeAction\n    }\n    summaries(first: $summaryFirst) {\n      edges {\n        node {\n          ...FeedBadgeSummary\n        }\n      }\n    }\n  }\n  \n  \n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        id\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        id\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetConnectionsLight {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          providerId\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n"): (typeof documents)["\n  query GetConnectionsLight {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          providerId\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetConnection($id: ID!) {\n    connection(id: $id) {\n      id\n      name\n      active\n      schedule\n      tokenExpiry\n      syncState\n      activeEndpoints\n      providerId\n      needsReauth\n      externalId\n      provider {\n        id\n        name\n        authType\n        endpoints {\n          name\n          description\n          iterationType\n          TTL\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetConnection($id: ID!) {\n    connection(id: $id) {\n      id\n      name\n      active\n      schedule\n      tokenExpiry\n      syncState\n      activeEndpoints\n      providerId\n      needsReauth\n      externalId\n      provider {\n        id\n        name\n        authType\n        endpoints {\n          name\n          description\n          iterationType\n          TTL\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateConnection($input: UpdateConnectionInput!) {\n    updateConnection(input: $input) {\n      success\n      connection {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          provider {\n              id\n              name\n              authType\n              endpoints {\n                name\n                description\n                iterationType\n                TTL\n              }\n          }\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateConnection($input: UpdateConnectionInput!) {\n    updateConnection(input: $input) {\n      success\n      connection {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          provider {\n              id\n              name\n              authType\n              endpoints {\n                name\n                description\n                iterationType\n                TTL\n              }\n          }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation DeleteConnection($input: DeleteByIdInput!) {\n    deleteConnection(input: $input) {\n      success\n      deletedId\n    }\n  }\n"): (typeof documents)["\n  mutation DeleteConnection($input: DeleteByIdInput!) {\n    deleteConnection(input: $input) {\n      success\n      deletedId\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetConnectionSyncJobs($connectionId: ID!, $endpointName: String, $type: String, $first: Int) {\n    connectionSyncJobs(connectionId: $connectionId, endpointName: $endpointName, type: $type, first: $first) {\n      edges {\n        cursor\n        node {\n          id\n          cursor\n          endpointName\n          nextCursor\n          connectionId\n          status\n          type\n          createdAt\n          updatedAt\n          completedAt\n          error\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n"): (typeof documents)["\n  query GetConnectionSyncJobs($connectionId: ID!, $endpointName: String, $type: String, $first: Int) {\n    connectionSyncJobs(connectionId: $connectionId, endpointName: $endpointName, type: $type, first: $first) {\n      edges {\n        cursor\n        node {\n          id\n          cursor\n          endpointName\n          nextCursor\n          connectionId\n          status\n          type\n          createdAt\n          updatedAt\n          completedAt\n          error\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetConnections {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          provider {\n            id\n            name\n            localOnly\n            endpoints {\n              name\n              description\n            }\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n"): (typeof documents)["\n  query GetConnections {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          provider {\n            id\n            name\n            localOnly\n            endpoints {\n              name\n              description\n            }\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        id\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        id\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        id\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        id\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment InsightCardData on InsightItemType {\n    title\n    summaryText\n    keyActions\n    relevanceScore\n    tags\n    relatedEntityIds\n  }\n"): (typeof documents)["\n  fragment InsightCardData on InsightItemType {\n    title\n    summaryText\n    keyActions\n    relevanceScore\n    tags\n    relatedEntityIds\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SummaryCardData on SummaryType {\n    id\n    title\n    periodType\n    seen\n    summaryText\n    keyInsights\n    tags\n    activityCounts {\n      total\n    }\n  }\n"): (typeof documents)["\n  fragment SummaryCardData on SummaryType {\n    id\n    title\n    periodType\n    seen\n    summaryText\n    keyInsights\n    tags\n    activityCounts {\n      total\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          seen\n          dismissed\n          summaryText\n          keyInsights\n          tags\n          activityCounts {\n            total\n          }\n          insights {\n            title\n            summaryText\n            keyActions\n            relevanceScore\n            tags\n            relatedEntityIds\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n"): (typeof documents)["\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          seen\n          dismissed\n          summaryText\n          keyInsights\n          tags\n          activityCounts {\n            total\n          }\n          insights {\n            title\n            summaryText\n            keyActions\n            relevanceScore\n            tags\n            relatedEntityIds\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation MarkSummaryAsSeen($id: ID!) {\n    markSummaryAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n"): (typeof documents)["\n  mutation MarkSummaryAsSeen($id: ID!) {\n    markSummaryAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation MarkSummaryAsDismissed($id: ID!) {\n    markSummaryAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n"): (typeof documents)["\n  mutation MarkSummaryAsDismissed($id: ID!) {\n    markSummaryAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    previewUrl\n  }\n"): (typeof documents)["\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    previewUrl\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            sourceUrl\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            sourceUrl\n          }\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TimelineBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n    actionType\n    duration\n    time\n  }\n"): (typeof documents)["\n  fragment TimelineBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n    actionType\n    duration\n    time\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TimelineCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n    communicationContent: content\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n    to {\n      edges {\n        node {\n          id\n          name\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  fragment TimelineCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n    communicationContent: content\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n    to {\n      edges {\n        node {\n          id\n          name\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TimelineEventCardData on EventType {\n    id\n    title\n    description\n    startTime\n    endTime\n    location {\n      ... on PlaceType {\n        id\n        name\n        properties\n      }\n    }\n  }\n"): (typeof documents)["\n  fragment TimelineEventCardData on EventType {\n    id\n    title\n    description\n    startTime\n    endTime\n    location {\n      ... on PlaceType {\n        id\n        name\n        properties\n      }\n    }\n  }\n"];
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
export function gql(source: "\n  fragment TableFileRowData on FileType {\n    id\n    filename\n    title\n    previewUrl\n    contentType\n  }\n"): (typeof documents)["\n  fragment TableFileRowData on FileType {\n    id\n    filename\n    title\n    previewUrl\n    contentType\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n"): (typeof documents)["\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n"];
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
export function gql(source: "\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...AnswerGridItemData\n          ...BrowserActivityGridItemData\n          ...CommunicationGridItemData\n          ...ConceptGridItemData\n          ...ContentGridItemData\n          ...EventGridItemData\n          ...FileGridItemData\n          ...NoteGridItemData\n          ...ItemGridItemData\n          ...PersonGridItemData\n          ...PlaceGridItemData\n          ...ThreadGridItemData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n\n          ...TimelineBrowserActivityCardData\n          ...TimelineCommunicationCardData\n          ...TimelineEventCardData\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ...AnswerGridItemData\n          ...BrowserActivityGridItemData\n          ...CommunicationGridItemData\n          ...ConceptGridItemData\n          ...ContentGridItemData\n          ...EventGridItemData\n          ...FileGridItemData\n          ...NoteGridItemData\n          ...ItemGridItemData\n          ...PersonGridItemData\n          ...PlaceGridItemData\n          ...ThreadGridItemData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n\n          ...TimelineBrowserActivityCardData\n          ...TimelineCommunicationCardData\n          ...TimelineEventCardData\n        }\n      }\n    }\n  }\n"];
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
export function gql(source: "\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        id\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        id\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n"): (typeof documents)["\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      authType\n      localOnly\n      appSetupUrl\n      openidKeyLink\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n"): (typeof documents)["\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      authType\n      localOnly\n      appSetupUrl\n      openidKeyLink\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n"];
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
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation CreateProviderKey($input: CreateProviderKeyInput!) {\n    createProviderKey(input: $input) {\n      id\n      providerId\n      clientId\n      clientSecret\n      userId\n    }\n  }\n"): (typeof documents)["\n  mutation CreateProviderKey($input: CreateProviderKeyInput!) {\n    createProviderKey(input: $input) {\n      id\n      providerId\n      clientId\n      clientSecret\n      userId\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateProviderKey($id: ID!, $input: UpdateProviderKeyInput!) {\n    updateProviderKey(id: $id, input: $input) {\n      id\n      clientId\n      clientSecret\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateProviderKey($id: ID!, $input: UpdateProviderKeyInput!) {\n    updateProviderKey(id: $id, input: $input) {\n      id\n      clientId\n      clientSecret\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation DeleteProviderKey($id: ID!) {\n    deleteProviderKey(id: $id)\n  }\n"): (typeof documents)["\n  mutation DeleteProviderKey($id: ID!) {\n    deleteProviderKey(id: $id)\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n"): (typeof documents)["\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetTag($id: ID!) {\n    tag(id: $id) {\n      id\n      label\n      description\n\n      entities {\n        edges {\n          node {\n            __typename\n\n            ... on Node {\n              id\n            }\n\n            ...ActionGridItemData\n            ...BrowserActivityGridItemData\n            ...CommunicationGridItemData\n            ...ConceptGridItemData\n            ...ContentGridItemData\n            ...EventGridItemData\n            ...FileGridItemData\n            ...NoteGridItemData\n            ...ItemGridItemData\n            ...PersonGridItemData\n            ...PlaceGridItemData\n            ...ThreadGridItemData\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetTag($id: ID!) {\n    tag(id: $id) {\n      id\n      label\n      description\n\n      entities {\n        edges {\n          node {\n            __typename\n\n            ... on Node {\n              id\n            }\n\n            ...ActionGridItemData\n            ...BrowserActivityGridItemData\n            ...CommunicationGridItemData\n            ...ConceptGridItemData\n            ...ContentGridItemData\n            ...EventGridItemData\n            ...FileGridItemData\n            ...NoteGridItemData\n            ...ItemGridItemData\n            ...PersonGridItemData\n            ...PlaceGridItemData\n            ...ThreadGridItemData\n          }\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetTags {\n    tags {\n      edges {\n        node {\n          id\n          label\n          description\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetTags {\n    tags {\n      edges {\n        node {\n          id\n          label\n          description\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetOAuthCallbackUrl {\n    oAuthCallbackUrl\n  }\n"): (typeof documents)["\n  query GetOAuthCallbackUrl {\n    oAuthCallbackUrl\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetProviders {\n    providers {\n      edges {\n        cursor\n        node {\n          id\n          name\n          description\n          logoUrl\n          localOnly\n          appSetupUrl\n          authType\n          scopes\n          providerKeys {\n            id\n            clientId\n            clientSecret\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetProviders {\n    providers {\n      edges {\n        cursor\n        node {\n          id\n          name\n          description\n          logoUrl\n          localOnly\n          appSetupUrl\n          authType\n          scopes\n          providerKeys {\n            id\n            clientId\n            clientSecret\n          }\n        }\n      }\n    }\n  }\n"];

export function gql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;