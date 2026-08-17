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
    "\n  mutation RescheduleEvent($id: ID!, $startTime: DateTime!, $endTime: DateTime) {\n    rescheduleEvent(id: $id, startTime: $startTime, endTime: $endTime) {\n      id\n      title\n      startTime\n      endTime\n      externalSyncStatus\n    }\n  }\n": typeof types.RescheduleEventDocument,
    "\n  query GetScheduleCandidates($from: DateTime!, $to: DateTime!) {\n    scheduleCandidates(from: $from, to: $to) {\n      id\n      title\n      description\n      rationale\n      rationaleSources { kind id note }\n      windowStart\n      windowEnd\n      timeFlex\n      durationMinutes\n      l0Class\n      fitScore\n      status\n      generator\n      confidence\n      personalization\n    }\n  }\n": typeof types.GetScheduleCandidatesDocument,
    "\n  mutation SyncScheduleSuggestions {\n    syncScheduleSuggestions\n  }\n": typeof types.SyncScheduleSuggestionsDocument,
    "\n  mutation AcceptCandidate($id: ID!, $startTime: DateTime!, $endTime: DateTime) {\n    acceptCandidate(id: $id, startTime: $startTime, endTime: $endTime) {\n      id\n      title\n      startTime\n      endTime\n      status\n    }\n  }\n": typeof types.AcceptCandidateDocument,
    "\n  mutation DeclineCandidate($id: ID!, $reason: String) {\n    declineCandidate(id: $id, reason: $reason) { id status }\n  }\n": typeof types.DeclineCandidateDocument,
    "\n  mutation SnoozeCandidate($id: ID!, $until: DateTime!) {\n    snoozeCandidate(id: $id, until: $until) { id status }\n  }\n": typeof types.SnoozeCandidateDocument,
    "\n  mutation BreakDownTasks($text: String!) {\n    breakDownTasks(text: $text) { id title }\n  }\n": typeof types.BreakDownTasksDocument,
    "\n  mutation ReturnEventToSlate($eventId: ID!) {\n    returnEventToSlate(eventId: $eventId) { id status }\n  }\n": typeof types.ReturnEventToSlateDocument,
    "\n  query GetSchedule($from: DateTime!, $to: DateTime!) {\n    eventsInRange(from: $from, to: $to) {\n      id\n      title\n      description\n      startTime\n      endTime\n      isAllDay\n      status\n      category\n      locationName\n      sourceSystem\n      externalSyncStatus\n      metadata\n    }\n    weekForecast(includeToday: true) {\n      generatedAt\n      days {\n        date\n        dow\n        clusters {\n          clusterId\n          name\n          l0Class\n          pOccur\n          scheduled\n          daypartProbs { label probability }\n        }\n      }\n    }\n  }\n": typeof types.GetScheduleDocument,
    "\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n": typeof types.TagEntitiesDocument,
    "\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n": typeof types.UntagEntitiesDocument,
    "\n  mutation TriggerHbpe {\n    triggerHbpe\n  }\n": typeof types.TriggerHbpeDocument,
    "\n  query GetWeekAhead {\n    weekForecast {\n      horizon\n      generatedAt\n      days {\n        date\n        dow\n        clusters {\n          clusterId\n          name\n          l0Class\n          pOccur\n          scheduled\n          daypartProbs { label probability }\n        }\n      }\n    }\n    dueForecast {\n      generatedAt\n      due {\n        clusterId\n        name\n        l0Class\n        lastSeen\n        daysSinceLast\n        medianIntervalDays\n        dueInDays\n        window\n        overdue\n        scheduledDate\n        confidence\n      }\n    }\n  }\n": typeof types.GetWeekAheadDocument,
    "\n  query GetTimelineEvents($from: DateTime!, $to: DateTime!) {\n    eventsInRange(from: $from, to: $to) {\n      id\n      title\n      description\n      startTime\n      endTime\n      isAllDay\n      status\n      category\n      locationName\n      sourceSystem\n      externalSyncStatus\n      metadata\n    }\n  }\n": typeof types.GetTimelineEventsDocument,
    "\n  query GetTags {\n    tags {\n      edges {\n        node {\n          id\n          label\n          description\n        }\n      }\n    }\n  }\n": typeof types.GetTagsDocument,
    "\n  query WhatBarEventTypes {\n    eventTypes\n  }\n": typeof types.WhatBarEventTypesDocument,
    "\n  query EventSources {\n    eventSources\n  }\n": typeof types.EventSourcesDocument,
    "\n  query EventTypes {\n    eventTypes\n  }\n": typeof types.EventTypesDocument,
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
    "\n  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $semantic: Boolean) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, semantic: $semantic }) {\n      matchingTags {\n        id\n        label\n      }\n\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          # Unmasked names so the header box can attach a who/where filter\n          # payload to person/place rows (arrow-key add/remove) without\n          # per-item useFragment. Aliased to stay clear of the result\n          # fragments' own selections.\n          ... on PersonType {\n            filterName: name\n          }\n\n          ... on PlaceType {\n            filterName: name\n          }\n\n          ...SearchResultCommunicationData\n          ...SearchResultConceptData\n          ...SearchResultContentData\n          ...SearchResultEventData\n          ...SearchResultFileData\n          ...SearchResultItemData\n          ...SearchResultNoteData\n          ...SearchResultPersonData\n          ...SearchResultPlaceData\n          ...SearchResultThreadData\n        }\n      }\n    }\n  }\n": typeof types.SearchBoxQueryDocument,
    "\n  query GetConnections {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          accountLabel\n          provider {\n            id\n            name\n            localOnly\n            endpoints {\n              name\n              description\n            }\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": typeof types.GetConnectionsDocument,
    "\n  query GetConnectionsForOnboarding {\n    connections {\n      edges {\n        node {\n          id\n          name\n          active\n          needsReauth\n          providerId\n          syncState\n        }\n      }\n    }\n  }\n": typeof types.GetConnectionsForOnboardingDocument,
    "\n  fragment ActionGridItemData on ActionType {\n    id\n    actionTitle: title\n    actionText: text\n  }\n": typeof types.ActionGridItemDataFragmentDoc,
    "\n  fragment AnswerGridItemData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": typeof types.AnswerGridItemDataFragmentDoc,
    "\n  fragment BrowserActivityGridItemData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": typeof types.BrowserActivityGridItemDataFragmentDoc,
    "\n  fragment CommunicationGridItemData on CommunicationType {\n    id\n    subject\n    preview\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n  }\n": typeof types.CommunicationGridItemDataFragmentDoc,
    "\n  fragment ConceptGridItemData on ConceptType {\n    id\n    name\n    description\n  }\n": typeof types.ConceptGridItemDataFragmentDoc,
    "\n  fragment ContentGridItemData on ContentType {\n    id\n    title\n    text\n    contentUrl: url\n    sourceUrl\n    mimetype\n  }\n": typeof types.ContentGridItemDataFragmentDoc,
    "\n  fragment EventGridItemData on EventType {\n    id\n    title\n    description\n    startTime\n    eventType\n    locationName\n    sourceSystem\n  }\n": typeof types.EventGridItemDataFragmentDoc,
    "\n  fragment FileChunkGridItemData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    file {\n      id\n      filename\n    }\n  }\n": typeof types.FileChunkGridItemDataFragmentDoc,
    "\n  fragment FileGridItemData on FileType {\n    id\n    filename\n    previewUrl\n    contentType\n    sourceUrl\n    title\n    description\n    size\n    createdAt\n  }\n": typeof types.FileGridItemDataFragmentDoc,
    "\n  fragment ItemGridItemData on ItemType {\n    id\n    name\n    description\n    category\n    brand\n    model\n    currentValue\n    file {\n      id\n      sourceUrl\n    }\n  }\n": typeof types.ItemGridItemDataFragmentDoc,
    "\n  fragment NoteGridItemData on NoteType {\n    id\n    title\n    content\n    createdAt\n  }\n": typeof types.NoteGridItemDataFragmentDoc,
    "\n  fragment PersonGridItemData on PersonType {\n    id\n    name\n    description\n    avatarUrl\n    firstName\n    lastName\n    birthDate\n  }\n": typeof types.PersonGridItemDataFragmentDoc,
    "\n  fragment PlaceGridItemData on PlaceType {\n    id\n    name\n    description\n    properties\n  }\n": typeof types.PlaceGridItemDataFragmentDoc,
    "\n  fragment ThreadGridItemData on ThreadType {\n    id\n    name\n    description\n  }\n": typeof types.ThreadGridItemDataFragmentDoc,
    "\n  mutation CreateConcept($input: CreateConceptInput!) {\n    createConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n": typeof types.CreateConceptDocument,
    "\n  mutation CreatePerson($input: CreatePersonInput!) {\n    createPerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n      }\n    }\n  }\n": typeof types.CreatePersonDocument,
    "\n  mutation CreateRelationship($input: CreateRelationshipInput!) {\n    createRelationship(input: $input) {\n      success\n      relationship {\n        id\n        fromNodeId\n        fromNodeType\n        toNodeId\n        toNodeType\n        type\n        properties\n        isBidirectional\n        startDate\n        endDate\n      }\n    }\n  }\n": typeof types.CreateRelationshipDocument,
    "\n  query GetFilePreview($id: ID!) {\n    file(id: $id) {\n      id\n      filename\n      contentType\n      sourceUrl\n      previewUrl\n      createdAt\n    }\n  }\n": typeof types.GetFilePreviewDocument,
    "\n  mutation CreateItem($input: CreateItemInput!) {\n    createItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n": typeof types.CreateItemDocument,
    "\n  mutation UpdateItem($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n": typeof types.UpdateItemDocument,
    "\n                  fragment NewItem on ItemType {\n                    id\n                    name\n                    category\n                    description\n                    brand\n                    model\n                    currentValue\n                  }\n                ": typeof types.NewItemFragmentDoc,
    "\n  query GetUserData {\n    me {\n      id\n      name\n      email\n      onboarded\n      needsIdentityStep\n      timezone\n\n      entity {\n        id\n      }\n    }\n  }\n": typeof types.GetUserDataDocument,
    "\n  fragment FeedBadgeAction on ActionType {\n    id\n    seen\n    dismissed\n  }\n": typeof types.FeedBadgeActionFragmentDoc,
    "\n  fragment FeedBadgeSummary on SummaryType {\n    id\n    seen\n    dismissed\n  }\n": typeof types.FeedBadgeSummaryFragmentDoc,
    "\n  query GetFeedBadgeCount($actionLimit: Int, $summaryFirst: Int) {\n    feedActions(limit: $actionLimit) {\n      ...FeedBadgeAction\n    }\n    summaries(first: $summaryFirst) {\n      edges {\n        node {\n          ...FeedBadgeSummary\n        }\n      }\n    }\n  }\n  \n  \n": typeof types.GetFeedBadgeCountDocument,
    "\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetCommunicationDocument,
    "\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetConceptDocument,
    "\n  mutation UpdateConceptDescription($input: UpdateConceptInput!) {\n    updateConcept(input: $input) {\n      success\n      concept {\n        id\n        description\n      }\n    }\n  }\n": typeof types.UpdateConceptDescriptionDocument,
    "\n  query GetConnection($id: ID!) {\n    connection(id: $id) {\n      id\n      name\n      active\n      schedule\n      tokenExpiry\n      syncState\n      activeEndpoints\n      providerId\n      needsReauth\n      externalId\n      accountLabel\n      provider {\n        id\n        name\n        authType\n        endpoints {\n          name\n          description\n          iterationType\n          TTL\n        }\n      }\n    }\n  }\n": typeof types.GetConnectionDocument,
    "\n  mutation UpdateConnection($input: UpdateConnectionInput!) {\n    updateConnection(input: $input) {\n      success\n      connection {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          accountLabel\n          provider {\n              id\n              name\n              authType\n              endpoints {\n                name\n                description\n                iterationType\n                TTL\n              }\n          }\n      }\n    }\n  }\n": typeof types.UpdateConnectionDocument,
    "\n  mutation DeleteConnection($input: DeleteByIdInput!) {\n    deleteConnection(input: $input) {\n      success\n      deletedId\n    }\n  }\n": typeof types.DeleteConnectionDocument,
    "\n  query GetConnectionSyncJobs($connectionId: ID!, $endpointName: String, $type: String, $first: Int) {\n    connectionSyncJobs(connectionId: $connectionId, endpointName: $endpointName, type: $type, first: $first) {\n      edges {\n        cursor\n        node {\n          id\n          cursor\n          endpointName\n          nextCursor\n          connectionId\n          status\n          type\n          createdAt\n          updatedAt\n          completedAt\n          error\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": typeof types.GetConnectionSyncJobsDocument,
    "\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetContentDocument,
    "\n  mutation UpdateContentText($input: UpdateContentInput!) {\n    updateContent(input: $input) {\n      id\n      text\n    }\n  }\n": typeof types.UpdateContentTextDocument,
    "\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        id\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetEventDocument,
    "\n  mutation UpdateEventDescription($input: UpdateEventInput!) {\n    updateEvent(input: $input) {\n      id\n      description\n    }\n  }\n": typeof types.UpdateEventDescriptionDocument,
    "\n  fragment InsightCardData on InsightItemType {\n    title\n    summaryText\n    keyActions\n    relevanceScore\n    tags\n    relatedEntityIds\n  }\n": typeof types.InsightCardDataFragmentDoc,
    "\n  fragment SummaryCardData on SummaryType {\n    id\n    title\n    periodType\n    seen\n    summaryText\n    keyInsights\n    tags\n    activityCounts {\n      total\n    }\n  }\n": typeof types.SummaryCardDataFragmentDoc,
    "\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          seen\n          dismissed\n          summaryText\n          keyInsights\n          tags\n          activityCounts {\n            total\n          }\n          insights {\n            title\n            summaryText\n            keyActions\n            relevanceScore\n            tags\n            relatedEntityIds\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n": typeof types.GetSummariesDocument,
    "\n  mutation MarkSummaryAsSeen($id: ID!) {\n    markSummaryAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n": typeof types.MarkSummaryAsSeenDocument,
    "\n  mutation MarkSummaryAsDismissed($id: ID!) {\n    markSummaryAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n": typeof types.MarkSummaryAsDismissedDocument,
    "\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n": typeof types.GetFilesDocument,
    "\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    previewUrl\n  }\n": typeof types.FileGridItemFragmentFragmentDoc,
    "\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            sourceUrl\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetInventoryItemsDocument,
    "\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetItemDocument,
    "\n  mutation UpdateItemDescription($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      success\n      item {\n        id\n        description\n      }\n    }\n  }\n": typeof types.UpdateItemDescriptionDocument,
    "\n  query ActivityTimeline($start: String!, $end: String!, $filters: ActivityTimelineFiltersInput) {\n    activityTimeline(start: $start, end: $end, filters: $filters) {\n      date\n      count\n    }\n  }\n": typeof types.ActivityTimelineDocument,
    "\n  fragment TimelineBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n    actionType\n    duration\n    time\n    tags {\n      label\n    }\n  }\n": typeof types.TimelineBrowserActivityCardDataFragmentDoc,
    "\n  fragment TimelineCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n    communicationContent: content\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n    to {\n      edges {\n        node {\n          id\n          name\n        }\n      }\n    }\n    tags {\n      label\n    }\n  }\n": typeof types.TimelineCommunicationCardDataFragmentDoc,
    "\n  fragment TimelineEventCardData on EventType {\n    id\n    title\n    description\n    sourceSystem\n    startTime\n    endTime\n    locationName\n    location {\n      ... on PlaceType {\n        id\n        name\n        properties\n      }\n    }\n    previewUrl\n    mediaUrl\n    mediaContentType\n    mediaWidth\n    mediaHeight\n    mediaSize\n    tags {\n      label\n    }\n  }\n": typeof types.TimelineEventCardDataFragmentDoc,
    "\n  fragment TimelineFileChunkCardData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    createdAt\n    file {\n      id\n      filename\n      sourceUrl\n    }\n  }\n": typeof types.TimelineFileChunkCardDataFragmentDoc,
    "\n  mutation UpdateBrowserActivityDetail($input: UpdateBrowserActivityInput!) {\n    updateBrowserActivity(input: $input) {\n      id\n      title\n      url\n    }\n  }\n": typeof types.UpdateBrowserActivityDetailDocument,
    "\n  mutation UpdateCommunicationDetail($input: UpdateCommunicationInput!) {\n    updateCommunication(input: $input) {\n      id\n      subject\n      preview\n      communicationContent: content\n    }\n  }\n": typeof types.UpdateCommunicationDetailDocument,
    "\n  mutation UpdateConceptDetail($input: UpdateConceptInput!) {\n    updateConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n": typeof types.UpdateConceptDetailDocument,
    "\n  mutation UpdateContentDetail($input: UpdateContentInput!) {\n    updateContent(input: $input) {\n      id\n      title\n      text\n    }\n  }\n": typeof types.UpdateContentDetailDocument,
    "\n  mutation UpdateEventDetail($input: UpdateEventInput!) {\n    updateEvent(input: $input) {\n      id\n      title\n      description\n    }\n  }\n": typeof types.UpdateEventDetailDocument,
    "\n  mutation UpdateFileDetail($input: UpdateFileInput!) {\n    updateFile(input: $input) {\n      id\n      title\n      description\n    }\n  }\n": typeof types.UpdateFileDetailDocument,
    "\n  mutation UpdateItemDetail($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      success\n      item {\n        id\n        name\n        description\n        category\n        brand\n        model\n        currentValue\n      }\n    }\n  }\n": typeof types.UpdateItemDetailDocument,
    "\n  mutation UpdateNoteDetail($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n      }\n    }\n  }\n": typeof types.UpdateNoteDetailDocument,
    "\n  mutation UpdatePersonDetail($input: UpdatePersonInput!) {\n    updatePerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n        firstName\n        lastName\n        birthDate\n        avatarUrl\n      }\n    }\n  }\n": typeof types.UpdatePersonDetailDocument,
    "\n  mutation UpdatePlaceDetail($input: UpdatePlaceInput!) {\n    updatePlace(input: $input) {\n      id\n      name\n      description\n      properties\n    }\n  }\n": typeof types.UpdatePlaceDetailDocument,
    "\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n      filters {\n        eventTypes\n        startTime\n        endTime\n        datePreset\n        sortBy\n        sortOrder\n        connectors\n        people\n        places\n        hasLocation\n        semantic\n      }\n    }\n  }\n": typeof types.GetSavedSearchDocument,
    "\n  fragment TableAnswerRowData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": typeof types.TableAnswerRowDataFragmentDoc,
    "\n  fragment TableBrowserActivityRowData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": typeof types.TableBrowserActivityRowDataFragmentDoc,
    "\n  fragment TableCommunicationRowData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": typeof types.TableCommunicationRowDataFragmentDoc,
    "\n  fragment TableConceptRowData on ConceptType {\n    id\n    name\n    description\n  }\n": typeof types.TableConceptRowDataFragmentDoc,
    "\n  fragment TableContentRowData on ContentType {\n    id\n    title\n    text\n  }\n": typeof types.TableContentRowDataFragmentDoc,
    "\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n    startTime\n    locationName\n    previewUrl\n    mediaContentType\n  }\n": typeof types.TableEventRowDataFragmentDoc,
    "\n  fragment TableFileChunkRowData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    file {\n      id\n      filename\n    }\n  }\n": typeof types.TableFileChunkRowDataFragmentDoc,
    "\n  fragment TableFileRowData on FileType {\n    id\n    filename\n    title\n    previewUrl\n    sourceUrl\n    contentType\n  }\n": typeof types.TableFileRowDataFragmentDoc,
    "\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n": typeof types.TableItemRowDataFragmentDoc,
    "\n  fragment TableNoteRowData on NoteType {\n    id\n    title\n    content\n  }\n": typeof types.TableNoteRowDataFragmentDoc,
    "\n  fragment TablePersonRowData on PersonType {\n    id\n    name\n    description\n  }\n": typeof types.TablePersonRowDataFragmentDoc,
    "\n  fragment TablePlaceRowData on PlaceType {\n    id\n    name\n    description\n  }\n": typeof types.TablePlaceRowDataFragmentDoc,
    "\n  fragment TableThreadRowData on ThreadType {\n    id\n    name\n    description\n  }\n": typeof types.TableThreadRowDataFragmentDoc,
    "\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $includeFiles: Boolean, $eventTypes: [String!], $tags: [String!], $startTime: String, $endTime: String, $sortBy: String, $sortOrder: String, $connectors: [String!], $people: [String!], $places: [String!], $hasLocation: Boolean, $bbox: [Float!], $semantic: Boolean, $shareToken: String, $first: Int, $after: String) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, includeFiles: $includeFiles, eventTypes: $eventTypes, tags: $tags, startTime: $startTime, endTime: $endTime, sortBy: $sortBy, sortOrder: $sortOrder, connectors: $connectors, people: $people, places: $places, hasLocation: $hasLocation, bbox: $bbox, semantic: $semantic, shareToken: $shareToken, first: $first, after: $after }) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ... on Taggable {\n            tags {\n              label\n            }\n          }\n\n          # Unmasked media fields so the gallery can build real thumbnails and a\n          # cross-item lightbox without per-item useFragment calls. Aliased to\n          # stay clear of the grid fragments' own selections.\n          ... on FileType {\n            galleryContentType: contentType\n            galleryFilename: filename\n            galleryPreviewUrl: previewUrl\n            gallerySourceUrl: sourceUrl\n          }\n\n          ... on ContentType {\n            galleryMimetype: mimetype\n            galleryTitle: title\n            galleryContentUrl: url\n            galleryContentSourceUrl: sourceUrl\n          }\n\n          ...AnswerGridItemData\n          ...BrowserActivityGridItemData\n          ...CommunicationGridItemData\n          ...ConceptGridItemData\n          ...ContentGridItemData\n          ...EventGridItemData\n          ...FileChunkGridItemData\n          ...FileGridItemData\n          ...NoteGridItemData\n          ...ItemGridItemData\n          ...PersonGridItemData\n          ...PlaceGridItemData\n          ...ThreadGridItemData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileChunkRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n\n          ...TimelineBrowserActivityCardData\n          ...TimelineCommunicationCardData\n          ...TimelineEventCardData\n\n          # Aliased timestamps so date-grouping (getEntityTimestamp) can read the\n          # field the server sorts by without unmasking spread fragments. Mirrors\n          # SearchResolver.getEntityTimestamp (time ?? startTime).\n          ... on CommunicationType {\n            bucketTime: time\n          }\n\n          ... on BrowserActivityType {\n            bucketTime: time\n          }\n\n          ... on EventType {\n            bucketStartTime: startTime\n            # The event's kind (visited / messaged / traveled / …), unmasked so\n            # the Events tab can group its timeline by activity without\n            # unmasking the card fragment.\n            eventType\n            # Coordinates for the map. Events carry a PostGIS Point in\n            # locationCoordinates (GeoJSON [lng, lat]) even with no resolved\n            # location PlaceType; aliased + unmasked so the map can read it\n            # without unmasking the card fragment.\n            mapCoordinates: locationCoordinates\n\n            # Photo/video events carry their binary via a linked file; these\n            # aliased media fields let the gallery build real thumbnails + a\n            # lightbox (mirrors FileType/ContentType above). Null for non-media\n            # events. galleryLocationName feeds the derived \"Photo · place ·\n            # date\" tile caption (eventDisplayTitle).\n            # Distinct content-type alias: FileType.contentType is String! but\n            # EventType.mediaContentType is nullable String, so they can't share\n            # the galleryContentType response key (overlapping-fields rule).\n            galleryMediaContentType: mediaContentType\n            galleryPreviewUrl: previewUrl\n            gallerySourceUrl: mediaUrl\n            galleryTitle: title\n            galleryLocationName: locationName\n          }\n\n          ... on PlaceType {\n            mapProperties: properties\n          }\n\n          ...TimelineFileChunkCardData\n        }\n      }\n    }\n  }\n": typeof types.SearchDocument,
    "\n  query GetNote($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      content\n      updatedAt\n    }\n  }\n": typeof types.GetNoteDocument,
    "\n  mutation UpdateNote($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": typeof types.UpdateNoteDocument,
    "\n  mutation CreateNote($input: CreateNoteInput!) {\n    createNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": typeof types.CreateNoteDocument,
    "\n                  fragment NewNote on NoteType {\n                    id\n                    title\n                    content\n                    updatedAt\n                  }\n                ": typeof types.NewNoteFragmentDoc,
    "\n  mutation DeleteNote($input: DeleteByIdInput!) {\n    deleteNote(input: $input) {\n      success\n      deletedId\n    }\n  }\n": typeof types.DeleteNoteDocument,
    "\n  query GetPeople($query: String, $first: Int, $after: String) {\n    people(query: $query, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          name\n          description\n          firstName\n          lastName\n          avatarUrl\n          birthDate\n          isSelf\n          identifiers {\n            kind\n            value\n            label\n          }\n          interactionStats {\n            eventCount\n            communicationCount\n            lastInteractionAt\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetPeopleDocument,
    "\n  query GetPersonDuplicates {\n    personDuplicates {\n      reason\n      value\n      people {\n        id\n        name\n        description\n        avatarUrl\n        isSelf\n      }\n    }\n  }\n": typeof types.GetPersonDuplicatesDocument,
    "\n  mutation MergePeople($input: MergePeopleInput!) {\n    mergePeople(input: $input) {\n      success\n      person {\n        id\n        name\n      }\n    }\n  }\n": typeof types.MergePeopleDocument,
    "\n  mutation RejectPersonDuplicates($personIds: [ID!]!) {\n    rejectPersonDuplicates(personIds: $personIds)\n  }\n": typeof types.RejectPersonDuplicatesDocument,
    "\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetPersonDocument,
    "\n  mutation UpdatePersonDescription($input: UpdatePersonInput!) {\n    updatePerson(input: $input) {\n      success\n      person {\n        id\n        description\n      }\n    }\n  }\n": typeof types.UpdatePersonDescriptionDocument,
    "\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        id\n        label\n      }\n    }\n  }\n": typeof types.GetPlaceDocument,
    "\n  mutation UpdatePlaceDescription($input: UpdatePlaceInput!) {\n    updatePlace(input: $input) {\n      id\n      description\n    }\n  }\n": typeof types.UpdatePlaceDescriptionDocument,
    "\n  query GetPlaces($query: String) {\n    places(query: $query, first: 500) {\n      totalCount\n      edges {\n        node {\n          id\n          name\n          description\n          placeKind\n          latitude\n          longitude\n          parent {\n            id\n            name\n            placeKind\n          }\n          visitStats {\n            visitCount\n            firstVisitAt\n            lastVisitAt\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetPlacesDocument,
    "\n  query GetKnownPlaces {\n    knownPlaces {\n      id\n      locationId\n      label\n      kind\n      confidence\n      source\n      coordinates {\n        lat\n        lng\n      }\n    }\n    knownPlaceCandidates {\n      locationId\n      label\n      kind\n      lat\n      lng\n      eventCount\n      confidence\n    }\n  }\n": typeof types.GetKnownPlacesDocument,
    "\n  mutation ConfirmKnownPlace($input: UpdateKnownPlaceInput!) {\n    updateKnownPlace(input: $input) {\n      id\n      label\n      kind\n    }\n  }\n": typeof types.ConfirmKnownPlaceDocument,
    "\n  mutation DeleteTask($input: DeleteByIdInput!) {\n    deleteTask(input: $input) {\n      success\n      deletedId\n    }\n  }\n": typeof types.DeleteTaskDocument,
    "\n  mutation CreateTask($input: CreateTaskInput!) {\n    createTask(input: $input) {\n      success\n      task {\n        id\n        ...TaskRowFragment\n      }\n    }\n  }\n": typeof types.CreateTaskDocument,
    "\n  query GetTasks($first: Int, $after: String) {\n    tasks(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          status\n          priority\n          dueAt\n          scheduledFor\n          deferUntil\n          title\n          ...TaskRowFragment\n        }\n      }\n      totalCount\n    }\n  }\n": typeof types.GetTasksDocument,
    "\n  mutation CompleteTask($id: ID!) {\n    completeTask(id: $id) {\n      id\n      status\n      completedAt\n    }\n  }\n": typeof types.CompleteTaskDocument,
    "\n  mutation ReopenTask($id: ID!) {\n    reopenTask(id: $id) {\n      id\n      status\n      completedAt\n    }\n  }\n": typeof types.ReopenTaskDocument,
    "\n  fragment TaskRowFragment on TaskType {\n    id\n    title\n    description\n    status\n    priority\n    dueAt\n    scheduledFor\n    deferUntil\n    estimatedMinutes\n    completedAt\n  }\n": typeof types.TaskRowFragmentFragmentDoc,
    "\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n": typeof types.ProviderEndpointsFragmentFragmentDoc,
    "\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      authType\n      localOnly\n      appSetupUrl\n      openidKeyLink\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n": typeof types.GetProviderDocument,
    "\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        # Full grid fragment (incl. isPublic/shareToken/filters) so the created\n        # search can be handed straight to the share modal from \"Save & share\".\n        ...SavedSearchGridItemFragment\n      }\n    }\n  }\n": typeof types.CreateSavedSearchDocument,
    "\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n": typeof types.DeleteSavedSearchDocument,
    "\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n        filters {\n          eventTypes\n          startTime\n          endTime\n          datePreset\n          sortBy\n          sortOrder\n          connectors\n          people\n          places\n          hasLocation\n          semantic\n        }\n      }\n    }\n  }\n": typeof types.UpdateSavedSearchDocument,
    "\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n    filters {\n      eventTypes\n      startTime\n      endTime\n      datePreset\n      sortBy\n      sortOrder\n      connectors\n      people\n      places\n      hasLocation\n      semantic\n    }\n    isPublic\n    shareToken\n  }\n": typeof types.SavedSearchGridItemFragmentFragmentDoc,
    "\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n": typeof types.GetSavedSearchesDocument,
    "\n  mutation SetSavedSearchSharing($input: SetSavedSearchSharingInput!) {\n    setSavedSearchSharing(input: $input) {\n      success\n      savedSearch {\n        id\n        # Spread keeps the grid card's cache entry in sync (the \"Shared\" badge);\n        # the top-level isPublic/shareToken are unmasked so this modal can show\n        # the freshly minted link without reopening (useFragment is not reactive).\n        isPublic\n        shareToken\n        ...SavedSearchGridItemFragment\n      }\n    }\n  }\n": typeof types.SetSavedSearchSharingDocument,
    "\n  mutation CreateProviderKey($input: CreateProviderKeyInput!) {\n    createProviderKey(input: $input) {\n      id\n      providerId\n      clientId\n      clientSecret\n      userId\n    }\n  }\n": typeof types.CreateProviderKeyDocument,
    "\n  mutation UpdateProviderKey($id: ID!, $input: UpdateProviderKeyInput!) {\n    updateProviderKey(id: $id, input: $input) {\n      id\n      clientId\n      clientSecret\n    }\n  }\n": typeof types.UpdateProviderKeyDocument,
    "\n  mutation DeleteProviderKey($id: ID!) {\n    deleteProviderKey(id: $id)\n  }\n": typeof types.DeleteProviderKeyDocument,
    "\n  mutation UpdateCurrentUserTimezone($input: UpdateCurrentUserInput!) {\n    updateCurrentUser(input: $input) {\n      id\n      timezone\n    }\n  }\n": typeof types.UpdateCurrentUserTimezoneDocument,
    "\n  query GetSharedSavedSearch($token: String!) {\n    sharedSavedSearch(token: $token) {\n      id\n      name\n      description\n    }\n  }\n": typeof types.GetSharedSavedSearchDocument,
    "\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      insights {\n        title\n        summaryText\n        keyActions\n        relevanceScore\n        tags\n        relatedEntityIds\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n": typeof types.GetSummaryDocument,
    "\n  query GetOAuthCallbackUrl {\n    oAuthCallbackUrl\n  }\n": typeof types.GetOAuthCallbackUrlDocument,
    "\n  query GetProviders {\n    providers {\n      edges {\n        cursor\n        node {\n          id\n          name\n          description\n          logoUrl\n          localOnly\n          appSetupUrl\n          authType\n          scopes\n          providerKeys {\n            id\n            clientId\n            clientSecret\n          }\n        }\n      }\n    }\n  }\n": typeof types.GetProvidersDocument,
};
const documents: Documents = {
    "\n  query GetFeedActions($limit: Int) {\n    feedActions(limit: $limit) {\n      id\n      title\n      text\n      imageUrl\n      priority\n      seen\n      dismissed\n      metadata {\n        seen\n        type\n        context\n        relatedPerson\n      }\n      thread {\n        id\n      }\n    }\n  }\n": types.GetFeedActionsDocument,
    "\n  mutation MarkActionAsSeen($id: ID!) {\n    markActionAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n": types.MarkActionAsSeenDocument,
    "\n  mutation MarkActionAsDismissed($id: ID!) {\n    markActionAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n": types.MarkActionAsDismissedDocument,
    "\n  query GetForecast($horizon: String) {\n    forecast(horizon: $horizon) {\n      horizon\n      generatedAt\n      systemStatus\n      buckets {\n        bucketIndex\n        startTime\n        l0Probs { label probability }\n        l1Probs { label probability }\n        l2Probs { label probability }\n        q10\n        q50\n        q90\n      }\n    }\n  }\n": types.GetForecastDocument,
    "\n  mutation RescheduleEvent($id: ID!, $startTime: DateTime!, $endTime: DateTime) {\n    rescheduleEvent(id: $id, startTime: $startTime, endTime: $endTime) {\n      id\n      title\n      startTime\n      endTime\n      externalSyncStatus\n    }\n  }\n": types.RescheduleEventDocument,
    "\n  query GetScheduleCandidates($from: DateTime!, $to: DateTime!) {\n    scheduleCandidates(from: $from, to: $to) {\n      id\n      title\n      description\n      rationale\n      rationaleSources { kind id note }\n      windowStart\n      windowEnd\n      timeFlex\n      durationMinutes\n      l0Class\n      fitScore\n      status\n      generator\n      confidence\n      personalization\n    }\n  }\n": types.GetScheduleCandidatesDocument,
    "\n  mutation SyncScheduleSuggestions {\n    syncScheduleSuggestions\n  }\n": types.SyncScheduleSuggestionsDocument,
    "\n  mutation AcceptCandidate($id: ID!, $startTime: DateTime!, $endTime: DateTime) {\n    acceptCandidate(id: $id, startTime: $startTime, endTime: $endTime) {\n      id\n      title\n      startTime\n      endTime\n      status\n    }\n  }\n": types.AcceptCandidateDocument,
    "\n  mutation DeclineCandidate($id: ID!, $reason: String) {\n    declineCandidate(id: $id, reason: $reason) { id status }\n  }\n": types.DeclineCandidateDocument,
    "\n  mutation SnoozeCandidate($id: ID!, $until: DateTime!) {\n    snoozeCandidate(id: $id, until: $until) { id status }\n  }\n": types.SnoozeCandidateDocument,
    "\n  mutation BreakDownTasks($text: String!) {\n    breakDownTasks(text: $text) { id title }\n  }\n": types.BreakDownTasksDocument,
    "\n  mutation ReturnEventToSlate($eventId: ID!) {\n    returnEventToSlate(eventId: $eventId) { id status }\n  }\n": types.ReturnEventToSlateDocument,
    "\n  query GetSchedule($from: DateTime!, $to: DateTime!) {\n    eventsInRange(from: $from, to: $to) {\n      id\n      title\n      description\n      startTime\n      endTime\n      isAllDay\n      status\n      category\n      locationName\n      sourceSystem\n      externalSyncStatus\n      metadata\n    }\n    weekForecast(includeToday: true) {\n      generatedAt\n      days {\n        date\n        dow\n        clusters {\n          clusterId\n          name\n          l0Class\n          pOccur\n          scheduled\n          daypartProbs { label probability }\n        }\n      }\n    }\n  }\n": types.GetScheduleDocument,
    "\n  mutation TagEntities($input: TagEntitiesInput!) {\n    tagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n": types.TagEntitiesDocument,
    "\n  mutation UntagEntities($input: TagEntitiesInput!) {\n    untagEntities(input: $input) {\n      ... on Node {\n        id\n      }\n\n      ... on Taggable {\n        tags {\n          id\n          label\n        }\n      }\n    }\n  }\n": types.UntagEntitiesDocument,
    "\n  mutation TriggerHbpe {\n    triggerHbpe\n  }\n": types.TriggerHbpeDocument,
    "\n  query GetWeekAhead {\n    weekForecast {\n      horizon\n      generatedAt\n      days {\n        date\n        dow\n        clusters {\n          clusterId\n          name\n          l0Class\n          pOccur\n          scheduled\n          daypartProbs { label probability }\n        }\n      }\n    }\n    dueForecast {\n      generatedAt\n      due {\n        clusterId\n        name\n        l0Class\n        lastSeen\n        daysSinceLast\n        medianIntervalDays\n        dueInDays\n        window\n        overdue\n        scheduledDate\n        confidence\n      }\n    }\n  }\n": types.GetWeekAheadDocument,
    "\n  query GetTimelineEvents($from: DateTime!, $to: DateTime!) {\n    eventsInRange(from: $from, to: $to) {\n      id\n      title\n      description\n      startTime\n      endTime\n      isAllDay\n      status\n      category\n      locationName\n      sourceSystem\n      externalSyncStatus\n      metadata\n    }\n  }\n": types.GetTimelineEventsDocument,
    "\n  query GetTags {\n    tags {\n      edges {\n        node {\n          id\n          label\n          description\n        }\n      }\n    }\n  }\n": types.GetTagsDocument,
    "\n  query WhatBarEventTypes {\n    eventTypes\n  }\n": types.WhatBarEventTypesDocument,
    "\n  query EventSources {\n    eventSources\n  }\n": types.EventSourcesDocument,
    "\n  query EventTypes {\n    eventTypes\n  }\n": types.EventTypesDocument,
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
    "\n  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $semantic: Boolean) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, semantic: $semantic }) {\n      matchingTags {\n        id\n        label\n      }\n\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          # Unmasked names so the header box can attach a who/where filter\n          # payload to person/place rows (arrow-key add/remove) without\n          # per-item useFragment. Aliased to stay clear of the result\n          # fragments' own selections.\n          ... on PersonType {\n            filterName: name\n          }\n\n          ... on PlaceType {\n            filterName: name\n          }\n\n          ...SearchResultCommunicationData\n          ...SearchResultConceptData\n          ...SearchResultContentData\n          ...SearchResultEventData\n          ...SearchResultFileData\n          ...SearchResultItemData\n          ...SearchResultNoteData\n          ...SearchResultPersonData\n          ...SearchResultPlaceData\n          ...SearchResultThreadData\n        }\n      }\n    }\n  }\n": types.SearchBoxQueryDocument,
    "\n  query GetConnections {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          accountLabel\n          provider {\n            id\n            name\n            localOnly\n            endpoints {\n              name\n              description\n            }\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": types.GetConnectionsDocument,
    "\n  query GetConnectionsForOnboarding {\n    connections {\n      edges {\n        node {\n          id\n          name\n          active\n          needsReauth\n          providerId\n          syncState\n        }\n      }\n    }\n  }\n": types.GetConnectionsForOnboardingDocument,
    "\n  fragment ActionGridItemData on ActionType {\n    id\n    actionTitle: title\n    actionText: text\n  }\n": types.ActionGridItemDataFragmentDoc,
    "\n  fragment AnswerGridItemData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": types.AnswerGridItemDataFragmentDoc,
    "\n  fragment BrowserActivityGridItemData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": types.BrowserActivityGridItemDataFragmentDoc,
    "\n  fragment CommunicationGridItemData on CommunicationType {\n    id\n    subject\n    preview\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n  }\n": types.CommunicationGridItemDataFragmentDoc,
    "\n  fragment ConceptGridItemData on ConceptType {\n    id\n    name\n    description\n  }\n": types.ConceptGridItemDataFragmentDoc,
    "\n  fragment ContentGridItemData on ContentType {\n    id\n    title\n    text\n    contentUrl: url\n    sourceUrl\n    mimetype\n  }\n": types.ContentGridItemDataFragmentDoc,
    "\n  fragment EventGridItemData on EventType {\n    id\n    title\n    description\n    startTime\n    eventType\n    locationName\n    sourceSystem\n  }\n": types.EventGridItemDataFragmentDoc,
    "\n  fragment FileChunkGridItemData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    file {\n      id\n      filename\n    }\n  }\n": types.FileChunkGridItemDataFragmentDoc,
    "\n  fragment FileGridItemData on FileType {\n    id\n    filename\n    previewUrl\n    contentType\n    sourceUrl\n    title\n    description\n    size\n    createdAt\n  }\n": types.FileGridItemDataFragmentDoc,
    "\n  fragment ItemGridItemData on ItemType {\n    id\n    name\n    description\n    category\n    brand\n    model\n    currentValue\n    file {\n      id\n      sourceUrl\n    }\n  }\n": types.ItemGridItemDataFragmentDoc,
    "\n  fragment NoteGridItemData on NoteType {\n    id\n    title\n    content\n    createdAt\n  }\n": types.NoteGridItemDataFragmentDoc,
    "\n  fragment PersonGridItemData on PersonType {\n    id\n    name\n    description\n    avatarUrl\n    firstName\n    lastName\n    birthDate\n  }\n": types.PersonGridItemDataFragmentDoc,
    "\n  fragment PlaceGridItemData on PlaceType {\n    id\n    name\n    description\n    properties\n  }\n": types.PlaceGridItemDataFragmentDoc,
    "\n  fragment ThreadGridItemData on ThreadType {\n    id\n    name\n    description\n  }\n": types.ThreadGridItemDataFragmentDoc,
    "\n  mutation CreateConcept($input: CreateConceptInput!) {\n    createConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n": types.CreateConceptDocument,
    "\n  mutation CreatePerson($input: CreatePersonInput!) {\n    createPerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n      }\n    }\n  }\n": types.CreatePersonDocument,
    "\n  mutation CreateRelationship($input: CreateRelationshipInput!) {\n    createRelationship(input: $input) {\n      success\n      relationship {\n        id\n        fromNodeId\n        fromNodeType\n        toNodeId\n        toNodeType\n        type\n        properties\n        isBidirectional\n        startDate\n        endDate\n      }\n    }\n  }\n": types.CreateRelationshipDocument,
    "\n  query GetFilePreview($id: ID!) {\n    file(id: $id) {\n      id\n      filename\n      contentType\n      sourceUrl\n      previewUrl\n      createdAt\n    }\n  }\n": types.GetFilePreviewDocument,
    "\n  mutation CreateItem($input: CreateItemInput!) {\n    createItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n": types.CreateItemDocument,
    "\n  mutation UpdateItem($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      item {\n        id\n        name\n        category\n        description\n        brand\n        model\n        currentValue\n        tags {\n          id\n          label\n        }\n      }\n      success\n    }\n  }\n": types.UpdateItemDocument,
    "\n                  fragment NewItem on ItemType {\n                    id\n                    name\n                    category\n                    description\n                    brand\n                    model\n                    currentValue\n                  }\n                ": types.NewItemFragmentDoc,
    "\n  query GetUserData {\n    me {\n      id\n      name\n      email\n      onboarded\n      needsIdentityStep\n      timezone\n\n      entity {\n        id\n      }\n    }\n  }\n": types.GetUserDataDocument,
    "\n  fragment FeedBadgeAction on ActionType {\n    id\n    seen\n    dismissed\n  }\n": types.FeedBadgeActionFragmentDoc,
    "\n  fragment FeedBadgeSummary on SummaryType {\n    id\n    seen\n    dismissed\n  }\n": types.FeedBadgeSummaryFragmentDoc,
    "\n  query GetFeedBadgeCount($actionLimit: Int, $summaryFirst: Int) {\n    feedActions(limit: $actionLimit) {\n      ...FeedBadgeAction\n    }\n    summaries(first: $summaryFirst) {\n      edges {\n        node {\n          ...FeedBadgeSummary\n        }\n      }\n    }\n  }\n  \n  \n": types.GetFeedBadgeCountDocument,
    "\n  query GetCommunication($id: ID!) {\n    communication(id: $id) {\n      id\n      type\n      subject\n      preview\n      content\n\n      from {\n        id\n        name\n      }\n\n      to {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetCommunicationDocument,
    "\n  query GetConcept($id: ID!) {\n    concept(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetConceptDocument,
    "\n  mutation UpdateConceptDescription($input: UpdateConceptInput!) {\n    updateConcept(input: $input) {\n      success\n      concept {\n        id\n        description\n      }\n    }\n  }\n": types.UpdateConceptDescriptionDocument,
    "\n  query GetConnection($id: ID!) {\n    connection(id: $id) {\n      id\n      name\n      active\n      schedule\n      tokenExpiry\n      syncState\n      activeEndpoints\n      providerId\n      needsReauth\n      externalId\n      accountLabel\n      provider {\n        id\n        name\n        authType\n        endpoints {\n          name\n          description\n          iterationType\n          TTL\n        }\n      }\n    }\n  }\n": types.GetConnectionDocument,
    "\n  mutation UpdateConnection($input: UpdateConnectionInput!) {\n    updateConnection(input: $input) {\n      success\n      connection {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          accountLabel\n          provider {\n              id\n              name\n              authType\n              endpoints {\n                name\n                description\n                iterationType\n                TTL\n              }\n          }\n      }\n    }\n  }\n": types.UpdateConnectionDocument,
    "\n  mutation DeleteConnection($input: DeleteByIdInput!) {\n    deleteConnection(input: $input) {\n      success\n      deletedId\n    }\n  }\n": types.DeleteConnectionDocument,
    "\n  query GetConnectionSyncJobs($connectionId: ID!, $endpointName: String, $type: String, $first: Int) {\n    connectionSyncJobs(connectionId: $connectionId, endpointName: $endpointName, type: $type, first: $first) {\n      edges {\n        cursor\n        node {\n          id\n          cursor\n          endpointName\n          nextCursor\n          connectionId\n          status\n          type\n          createdAt\n          updatedAt\n          completedAt\n          error\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n": types.GetConnectionSyncJobsDocument,
    "\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetContentDocument,
    "\n  mutation UpdateContentText($input: UpdateContentInput!) {\n    updateContent(input: $input) {\n      id\n      text\n    }\n  }\n": types.UpdateContentTextDocument,
    "\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        id\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n": types.GetEventDocument,
    "\n  mutation UpdateEventDescription($input: UpdateEventInput!) {\n    updateEvent(input: $input) {\n      id\n      description\n    }\n  }\n": types.UpdateEventDescriptionDocument,
    "\n  fragment InsightCardData on InsightItemType {\n    title\n    summaryText\n    keyActions\n    relevanceScore\n    tags\n    relatedEntityIds\n  }\n": types.InsightCardDataFragmentDoc,
    "\n  fragment SummaryCardData on SummaryType {\n    id\n    title\n    periodType\n    seen\n    summaryText\n    keyInsights\n    tags\n    activityCounts {\n      total\n    }\n  }\n": types.SummaryCardDataFragmentDoc,
    "\n  query GetSummaries($first: Int) {\n    summaries(first: $first) {\n      edges {\n        node {\n          id\n          title\n          periodType\n          seen\n          dismissed\n          summaryText\n          keyInsights\n          tags\n          activityCounts {\n            total\n          }\n          insights {\n            title\n            summaryText\n            keyActions\n            relevanceScore\n            tags\n            relatedEntityIds\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n      }\n      totalCount\n    }\n  }\n": types.GetSummariesDocument,
    "\n  mutation MarkSummaryAsSeen($id: ID!) {\n    markSummaryAsSeen(id: $id) {\n      id\n      seen\n    }\n  }\n": types.MarkSummaryAsSeenDocument,
    "\n  mutation MarkSummaryAsDismissed($id: ID!) {\n    markSummaryAsDismissed(id: $id) {\n      id\n      dismissed\n    }\n  }\n": types.MarkSummaryAsDismissedDocument,
    "\n  query GetFiles($first: Int, $after: String) {\n    files(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...FileGridItemFragment\n        }\n      }\n    }\n  }\n": types.GetFilesDocument,
    "\n  fragment FileGridItemFragment on FileType {\n    id\n    filename\n    previewUrl\n  }\n": types.FileGridItemFragmentFragmentDoc,
    "\n  query GetInventoryItems {\n    items {\n      edges {\n        node {\n          id\n          name\n          category\n          description\n          brand\n          model\n          currentValue\n          file {\n            sourceUrl\n          }\n        }\n      }\n    }\n  }\n": types.GetInventoryItemsDocument,
    "\n  query GetItem($id: ID!) {\n    item(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetItemDocument,
    "\n  mutation UpdateItemDescription($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      success\n      item {\n        id\n        description\n      }\n    }\n  }\n": types.UpdateItemDescriptionDocument,
    "\n  query ActivityTimeline($start: String!, $end: String!, $filters: ActivityTimelineFiltersInput) {\n    activityTimeline(start: $start, end: $end, filters: $filters) {\n      date\n      count\n    }\n  }\n": types.ActivityTimelineDocument,
    "\n  fragment TimelineBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n    actionType\n    duration\n    time\n    tags {\n      label\n    }\n  }\n": types.TimelineBrowserActivityCardDataFragmentDoc,
    "\n  fragment TimelineCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n    communicationContent: content\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n    to {\n      edges {\n        node {\n          id\n          name\n        }\n      }\n    }\n    tags {\n      label\n    }\n  }\n": types.TimelineCommunicationCardDataFragmentDoc,
    "\n  fragment TimelineEventCardData on EventType {\n    id\n    title\n    description\n    sourceSystem\n    startTime\n    endTime\n    locationName\n    location {\n      ... on PlaceType {\n        id\n        name\n        properties\n      }\n    }\n    previewUrl\n    mediaUrl\n    mediaContentType\n    mediaWidth\n    mediaHeight\n    mediaSize\n    tags {\n      label\n    }\n  }\n": types.TimelineEventCardDataFragmentDoc,
    "\n  fragment TimelineFileChunkCardData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    createdAt\n    file {\n      id\n      filename\n      sourceUrl\n    }\n  }\n": types.TimelineFileChunkCardDataFragmentDoc,
    "\n  mutation UpdateBrowserActivityDetail($input: UpdateBrowserActivityInput!) {\n    updateBrowserActivity(input: $input) {\n      id\n      title\n      url\n    }\n  }\n": types.UpdateBrowserActivityDetailDocument,
    "\n  mutation UpdateCommunicationDetail($input: UpdateCommunicationInput!) {\n    updateCommunication(input: $input) {\n      id\n      subject\n      preview\n      communicationContent: content\n    }\n  }\n": types.UpdateCommunicationDetailDocument,
    "\n  mutation UpdateConceptDetail($input: UpdateConceptInput!) {\n    updateConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n": types.UpdateConceptDetailDocument,
    "\n  mutation UpdateContentDetail($input: UpdateContentInput!) {\n    updateContent(input: $input) {\n      id\n      title\n      text\n    }\n  }\n": types.UpdateContentDetailDocument,
    "\n  mutation UpdateEventDetail($input: UpdateEventInput!) {\n    updateEvent(input: $input) {\n      id\n      title\n      description\n    }\n  }\n": types.UpdateEventDetailDocument,
    "\n  mutation UpdateFileDetail($input: UpdateFileInput!) {\n    updateFile(input: $input) {\n      id\n      title\n      description\n    }\n  }\n": types.UpdateFileDetailDocument,
    "\n  mutation UpdateItemDetail($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      success\n      item {\n        id\n        name\n        description\n        category\n        brand\n        model\n        currentValue\n      }\n    }\n  }\n": types.UpdateItemDetailDocument,
    "\n  mutation UpdateNoteDetail($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n      }\n    }\n  }\n": types.UpdateNoteDetailDocument,
    "\n  mutation UpdatePersonDetail($input: UpdatePersonInput!) {\n    updatePerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n        firstName\n        lastName\n        birthDate\n        avatarUrl\n      }\n    }\n  }\n": types.UpdatePersonDetailDocument,
    "\n  mutation UpdatePlaceDetail($input: UpdatePlaceInput!) {\n    updatePlace(input: $input) {\n      id\n      name\n      description\n      properties\n    }\n  }\n": types.UpdatePlaceDetailDocument,
    "\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n      filters {\n        eventTypes\n        startTime\n        endTime\n        datePreset\n        sortBy\n        sortOrder\n        connectors\n        people\n        places\n        hasLocation\n        semantic\n      }\n    }\n  }\n": types.GetSavedSearchDocument,
    "\n  fragment TableAnswerRowData on AnswerType {\n    id\n    answer\n    question {\n      id\n      text\n    }\n  }\n": types.TableAnswerRowDataFragmentDoc,
    "\n  fragment TableBrowserActivityRowData on BrowserActivityType {\n    id\n    title\n    url\n  }\n": types.TableBrowserActivityRowDataFragmentDoc,
    "\n  fragment TableCommunicationRowData on CommunicationType {\n    id\n    subject\n    preview\n  }\n": types.TableCommunicationRowDataFragmentDoc,
    "\n  fragment TableConceptRowData on ConceptType {\n    id\n    name\n    description\n  }\n": types.TableConceptRowDataFragmentDoc,
    "\n  fragment TableContentRowData on ContentType {\n    id\n    title\n    text\n  }\n": types.TableContentRowDataFragmentDoc,
    "\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n    startTime\n    locationName\n    previewUrl\n    mediaContentType\n  }\n": types.TableEventRowDataFragmentDoc,
    "\n  fragment TableFileChunkRowData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    file {\n      id\n      filename\n    }\n  }\n": types.TableFileChunkRowDataFragmentDoc,
    "\n  fragment TableFileRowData on FileType {\n    id\n    filename\n    title\n    previewUrl\n    sourceUrl\n    contentType\n  }\n": types.TableFileRowDataFragmentDoc,
    "\n  fragment TableItemRowData on ItemType {\n    id\n    name\n    description\n    file {\n      id\n      sourceUrl\n    }\n  }\n": types.TableItemRowDataFragmentDoc,
    "\n  fragment TableNoteRowData on NoteType {\n    id\n    title\n    content\n  }\n": types.TableNoteRowDataFragmentDoc,
    "\n  fragment TablePersonRowData on PersonType {\n    id\n    name\n    description\n  }\n": types.TablePersonRowDataFragmentDoc,
    "\n  fragment TablePlaceRowData on PlaceType {\n    id\n    name\n    description\n  }\n": types.TablePlaceRowDataFragmentDoc,
    "\n  fragment TableThreadRowData on ThreadType {\n    id\n    name\n    description\n  }\n": types.TableThreadRowDataFragmentDoc,
    "\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $includeFiles: Boolean, $eventTypes: [String!], $tags: [String!], $startTime: String, $endTime: String, $sortBy: String, $sortOrder: String, $connectors: [String!], $people: [String!], $places: [String!], $hasLocation: Boolean, $bbox: [Float!], $semantic: Boolean, $shareToken: String, $first: Int, $after: String) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, includeFiles: $includeFiles, eventTypes: $eventTypes, tags: $tags, startTime: $startTime, endTime: $endTime, sortBy: $sortBy, sortOrder: $sortOrder, connectors: $connectors, people: $people, places: $places, hasLocation: $hasLocation, bbox: $bbox, semantic: $semantic, shareToken: $shareToken, first: $first, after: $after }) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ... on Taggable {\n            tags {\n              label\n            }\n          }\n\n          # Unmasked media fields so the gallery can build real thumbnails and a\n          # cross-item lightbox without per-item useFragment calls. Aliased to\n          # stay clear of the grid fragments' own selections.\n          ... on FileType {\n            galleryContentType: contentType\n            galleryFilename: filename\n            galleryPreviewUrl: previewUrl\n            gallerySourceUrl: sourceUrl\n          }\n\n          ... on ContentType {\n            galleryMimetype: mimetype\n            galleryTitle: title\n            galleryContentUrl: url\n            galleryContentSourceUrl: sourceUrl\n          }\n\n          ...AnswerGridItemData\n          ...BrowserActivityGridItemData\n          ...CommunicationGridItemData\n          ...ConceptGridItemData\n          ...ContentGridItemData\n          ...EventGridItemData\n          ...FileChunkGridItemData\n          ...FileGridItemData\n          ...NoteGridItemData\n          ...ItemGridItemData\n          ...PersonGridItemData\n          ...PlaceGridItemData\n          ...ThreadGridItemData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileChunkRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n\n          ...TimelineBrowserActivityCardData\n          ...TimelineCommunicationCardData\n          ...TimelineEventCardData\n\n          # Aliased timestamps so date-grouping (getEntityTimestamp) can read the\n          # field the server sorts by without unmasking spread fragments. Mirrors\n          # SearchResolver.getEntityTimestamp (time ?? startTime).\n          ... on CommunicationType {\n            bucketTime: time\n          }\n\n          ... on BrowserActivityType {\n            bucketTime: time\n          }\n\n          ... on EventType {\n            bucketStartTime: startTime\n            # The event's kind (visited / messaged / traveled / …), unmasked so\n            # the Events tab can group its timeline by activity without\n            # unmasking the card fragment.\n            eventType\n            # Coordinates for the map. Events carry a PostGIS Point in\n            # locationCoordinates (GeoJSON [lng, lat]) even with no resolved\n            # location PlaceType; aliased + unmasked so the map can read it\n            # without unmasking the card fragment.\n            mapCoordinates: locationCoordinates\n\n            # Photo/video events carry their binary via a linked file; these\n            # aliased media fields let the gallery build real thumbnails + a\n            # lightbox (mirrors FileType/ContentType above). Null for non-media\n            # events. galleryLocationName feeds the derived \"Photo · place ·\n            # date\" tile caption (eventDisplayTitle).\n            # Distinct content-type alias: FileType.contentType is String! but\n            # EventType.mediaContentType is nullable String, so they can't share\n            # the galleryContentType response key (overlapping-fields rule).\n            galleryMediaContentType: mediaContentType\n            galleryPreviewUrl: previewUrl\n            gallerySourceUrl: mediaUrl\n            galleryTitle: title\n            galleryLocationName: locationName\n          }\n\n          ... on PlaceType {\n            mapProperties: properties\n          }\n\n          ...TimelineFileChunkCardData\n        }\n      }\n    }\n  }\n": types.SearchDocument,
    "\n  query GetNote($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      content\n      updatedAt\n    }\n  }\n": types.GetNoteDocument,
    "\n  mutation UpdateNote($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": types.UpdateNoteDocument,
    "\n  mutation CreateNote($input: CreateNoteInput!) {\n    createNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n        updatedAt\n      }\n    }\n  }\n": types.CreateNoteDocument,
    "\n                  fragment NewNote on NoteType {\n                    id\n                    title\n                    content\n                    updatedAt\n                  }\n                ": types.NewNoteFragmentDoc,
    "\n  mutation DeleteNote($input: DeleteByIdInput!) {\n    deleteNote(input: $input) {\n      success\n      deletedId\n    }\n  }\n": types.DeleteNoteDocument,
    "\n  query GetPeople($query: String, $first: Int, $after: String) {\n    people(query: $query, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          name\n          description\n          firstName\n          lastName\n          avatarUrl\n          birthDate\n          isSelf\n          identifiers {\n            kind\n            value\n            label\n          }\n          interactionStats {\n            eventCount\n            communicationCount\n            lastInteractionAt\n          }\n        }\n      }\n    }\n  }\n": types.GetPeopleDocument,
    "\n  query GetPersonDuplicates {\n    personDuplicates {\n      reason\n      value\n      people {\n        id\n        name\n        description\n        avatarUrl\n        isSelf\n      }\n    }\n  }\n": types.GetPersonDuplicatesDocument,
    "\n  mutation MergePeople($input: MergePeopleInput!) {\n    mergePeople(input: $input) {\n      success\n      person {\n        id\n        name\n      }\n    }\n  }\n": types.MergePeopleDocument,
    "\n  mutation RejectPersonDuplicates($personIds: [ID!]!) {\n    rejectPersonDuplicates(personIds: $personIds)\n  }\n": types.RejectPersonDuplicatesDocument,
    "\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetPersonDocument,
    "\n  mutation UpdatePersonDescription($input: UpdatePersonInput!) {\n    updatePerson(input: $input) {\n      success\n      person {\n        id\n        description\n      }\n    }\n  }\n": types.UpdatePersonDescriptionDocument,
    "\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        id\n        label\n      }\n    }\n  }\n": types.GetPlaceDocument,
    "\n  mutation UpdatePlaceDescription($input: UpdatePlaceInput!) {\n    updatePlace(input: $input) {\n      id\n      description\n    }\n  }\n": types.UpdatePlaceDescriptionDocument,
    "\n  query GetPlaces($query: String) {\n    places(query: $query, first: 500) {\n      totalCount\n      edges {\n        node {\n          id\n          name\n          description\n          placeKind\n          latitude\n          longitude\n          parent {\n            id\n            name\n            placeKind\n          }\n          visitStats {\n            visitCount\n            firstVisitAt\n            lastVisitAt\n          }\n        }\n      }\n    }\n  }\n": types.GetPlacesDocument,
    "\n  query GetKnownPlaces {\n    knownPlaces {\n      id\n      locationId\n      label\n      kind\n      confidence\n      source\n      coordinates {\n        lat\n        lng\n      }\n    }\n    knownPlaceCandidates {\n      locationId\n      label\n      kind\n      lat\n      lng\n      eventCount\n      confidence\n    }\n  }\n": types.GetKnownPlacesDocument,
    "\n  mutation ConfirmKnownPlace($input: UpdateKnownPlaceInput!) {\n    updateKnownPlace(input: $input) {\n      id\n      label\n      kind\n    }\n  }\n": types.ConfirmKnownPlaceDocument,
    "\n  mutation DeleteTask($input: DeleteByIdInput!) {\n    deleteTask(input: $input) {\n      success\n      deletedId\n    }\n  }\n": types.DeleteTaskDocument,
    "\n  mutation CreateTask($input: CreateTaskInput!) {\n    createTask(input: $input) {\n      success\n      task {\n        id\n        ...TaskRowFragment\n      }\n    }\n  }\n": types.CreateTaskDocument,
    "\n  query GetTasks($first: Int, $after: String) {\n    tasks(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          status\n          priority\n          dueAt\n          scheduledFor\n          deferUntil\n          title\n          ...TaskRowFragment\n        }\n      }\n      totalCount\n    }\n  }\n": types.GetTasksDocument,
    "\n  mutation CompleteTask($id: ID!) {\n    completeTask(id: $id) {\n      id\n      status\n      completedAt\n    }\n  }\n": types.CompleteTaskDocument,
    "\n  mutation ReopenTask($id: ID!) {\n    reopenTask(id: $id) {\n      id\n      status\n      completedAt\n    }\n  }\n": types.ReopenTaskDocument,
    "\n  fragment TaskRowFragment on TaskType {\n    id\n    title\n    description\n    status\n    priority\n    dueAt\n    scheduledFor\n    deferUntil\n    estimatedMinutes\n    completedAt\n  }\n": types.TaskRowFragmentFragmentDoc,
    "\n  fragment ProviderEndpointsFragment on ProviderType {\n    endpoints {\n      name\n      description\n    }\n  }\n": types.ProviderEndpointsFragmentFragmentDoc,
    "\n  query GetProvider($id: ID!) {\n    provider(id: $id) {\n      id\n      name\n      description\n      logoUrl\n      authType\n      localOnly\n      appSetupUrl\n      openidKeyLink\n      theme {\n        backgroundColor\n        borderColor\n      }\n      ...ProviderEndpointsFragment\n    }\n  }\n": types.GetProviderDocument,
    "\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        # Full grid fragment (incl. isPublic/shareToken/filters) so the created\n        # search can be handed straight to the share modal from \"Save & share\".\n        ...SavedSearchGridItemFragment\n      }\n    }\n  }\n": types.CreateSavedSearchDocument,
    "\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n": types.DeleteSavedSearchDocument,
    "\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n        filters {\n          eventTypes\n          startTime\n          endTime\n          datePreset\n          sortBy\n          sortOrder\n          connectors\n          people\n          places\n          hasLocation\n          semantic\n        }\n      }\n    }\n  }\n": types.UpdateSavedSearchDocument,
    "\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n    filters {\n      eventTypes\n      startTime\n      endTime\n      datePreset\n      sortBy\n      sortOrder\n      connectors\n      people\n      places\n      hasLocation\n      semantic\n    }\n    isPublic\n    shareToken\n  }\n": types.SavedSearchGridItemFragmentFragmentDoc,
    "\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n": types.GetSavedSearchesDocument,
    "\n  mutation SetSavedSearchSharing($input: SetSavedSearchSharingInput!) {\n    setSavedSearchSharing(input: $input) {\n      success\n      savedSearch {\n        id\n        # Spread keeps the grid card's cache entry in sync (the \"Shared\" badge);\n        # the top-level isPublic/shareToken are unmasked so this modal can show\n        # the freshly minted link without reopening (useFragment is not reactive).\n        isPublic\n        shareToken\n        ...SavedSearchGridItemFragment\n      }\n    }\n  }\n": types.SetSavedSearchSharingDocument,
    "\n  mutation CreateProviderKey($input: CreateProviderKeyInput!) {\n    createProviderKey(input: $input) {\n      id\n      providerId\n      clientId\n      clientSecret\n      userId\n    }\n  }\n": types.CreateProviderKeyDocument,
    "\n  mutation UpdateProviderKey($id: ID!, $input: UpdateProviderKeyInput!) {\n    updateProviderKey(id: $id, input: $input) {\n      id\n      clientId\n      clientSecret\n    }\n  }\n": types.UpdateProviderKeyDocument,
    "\n  mutation DeleteProviderKey($id: ID!) {\n    deleteProviderKey(id: $id)\n  }\n": types.DeleteProviderKeyDocument,
    "\n  mutation UpdateCurrentUserTimezone($input: UpdateCurrentUserInput!) {\n    updateCurrentUser(input: $input) {\n      id\n      timezone\n    }\n  }\n": types.UpdateCurrentUserTimezoneDocument,
    "\n  query GetSharedSavedSearch($token: String!) {\n    sharedSavedSearch(token: $token) {\n      id\n      name\n      description\n    }\n  }\n": types.GetSharedSavedSearchDocument,
    "\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      insights {\n        title\n        summaryText\n        keyActions\n        relevanceScore\n        tags\n        relatedEntityIds\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n": types.GetSummaryDocument,
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
export function gql(source: "\n  mutation RescheduleEvent($id: ID!, $startTime: DateTime!, $endTime: DateTime) {\n    rescheduleEvent(id: $id, startTime: $startTime, endTime: $endTime) {\n      id\n      title\n      startTime\n      endTime\n      externalSyncStatus\n    }\n  }\n"): (typeof documents)["\n  mutation RescheduleEvent($id: ID!, $startTime: DateTime!, $endTime: DateTime) {\n    rescheduleEvent(id: $id, startTime: $startTime, endTime: $endTime) {\n      id\n      title\n      startTime\n      endTime\n      externalSyncStatus\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetScheduleCandidates($from: DateTime!, $to: DateTime!) {\n    scheduleCandidates(from: $from, to: $to) {\n      id\n      title\n      description\n      rationale\n      rationaleSources { kind id note }\n      windowStart\n      windowEnd\n      timeFlex\n      durationMinutes\n      l0Class\n      fitScore\n      status\n      generator\n      confidence\n      personalization\n    }\n  }\n"): (typeof documents)["\n  query GetScheduleCandidates($from: DateTime!, $to: DateTime!) {\n    scheduleCandidates(from: $from, to: $to) {\n      id\n      title\n      description\n      rationale\n      rationaleSources { kind id note }\n      windowStart\n      windowEnd\n      timeFlex\n      durationMinutes\n      l0Class\n      fitScore\n      status\n      generator\n      confidence\n      personalization\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation SyncScheduleSuggestions {\n    syncScheduleSuggestions\n  }\n"): (typeof documents)["\n  mutation SyncScheduleSuggestions {\n    syncScheduleSuggestions\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation AcceptCandidate($id: ID!, $startTime: DateTime!, $endTime: DateTime) {\n    acceptCandidate(id: $id, startTime: $startTime, endTime: $endTime) {\n      id\n      title\n      startTime\n      endTime\n      status\n    }\n  }\n"): (typeof documents)["\n  mutation AcceptCandidate($id: ID!, $startTime: DateTime!, $endTime: DateTime) {\n    acceptCandidate(id: $id, startTime: $startTime, endTime: $endTime) {\n      id\n      title\n      startTime\n      endTime\n      status\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation DeclineCandidate($id: ID!, $reason: String) {\n    declineCandidate(id: $id, reason: $reason) { id status }\n  }\n"): (typeof documents)["\n  mutation DeclineCandidate($id: ID!, $reason: String) {\n    declineCandidate(id: $id, reason: $reason) { id status }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation SnoozeCandidate($id: ID!, $until: DateTime!) {\n    snoozeCandidate(id: $id, until: $until) { id status }\n  }\n"): (typeof documents)["\n  mutation SnoozeCandidate($id: ID!, $until: DateTime!) {\n    snoozeCandidate(id: $id, until: $until) { id status }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation BreakDownTasks($text: String!) {\n    breakDownTasks(text: $text) { id title }\n  }\n"): (typeof documents)["\n  mutation BreakDownTasks($text: String!) {\n    breakDownTasks(text: $text) { id title }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation ReturnEventToSlate($eventId: ID!) {\n    returnEventToSlate(eventId: $eventId) { id status }\n  }\n"): (typeof documents)["\n  mutation ReturnEventToSlate($eventId: ID!) {\n    returnEventToSlate(eventId: $eventId) { id status }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSchedule($from: DateTime!, $to: DateTime!) {\n    eventsInRange(from: $from, to: $to) {\n      id\n      title\n      description\n      startTime\n      endTime\n      isAllDay\n      status\n      category\n      locationName\n      sourceSystem\n      externalSyncStatus\n      metadata\n    }\n    weekForecast(includeToday: true) {\n      generatedAt\n      days {\n        date\n        dow\n        clusters {\n          clusterId\n          name\n          l0Class\n          pOccur\n          scheduled\n          daypartProbs { label probability }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetSchedule($from: DateTime!, $to: DateTime!) {\n    eventsInRange(from: $from, to: $to) {\n      id\n      title\n      description\n      startTime\n      endTime\n      isAllDay\n      status\n      category\n      locationName\n      sourceSystem\n      externalSyncStatus\n      metadata\n    }\n    weekForecast(includeToday: true) {\n      generatedAt\n      days {\n        date\n        dow\n        clusters {\n          clusterId\n          name\n          l0Class\n          pOccur\n          scheduled\n          daypartProbs { label probability }\n        }\n      }\n    }\n  }\n"];
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
export function gql(source: "\n  query GetWeekAhead {\n    weekForecast {\n      horizon\n      generatedAt\n      days {\n        date\n        dow\n        clusters {\n          clusterId\n          name\n          l0Class\n          pOccur\n          scheduled\n          daypartProbs { label probability }\n        }\n      }\n    }\n    dueForecast {\n      generatedAt\n      due {\n        clusterId\n        name\n        l0Class\n        lastSeen\n        daysSinceLast\n        medianIntervalDays\n        dueInDays\n        window\n        overdue\n        scheduledDate\n        confidence\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetWeekAhead {\n    weekForecast {\n      horizon\n      generatedAt\n      days {\n        date\n        dow\n        clusters {\n          clusterId\n          name\n          l0Class\n          pOccur\n          scheduled\n          daypartProbs { label probability }\n        }\n      }\n    }\n    dueForecast {\n      generatedAt\n      due {\n        clusterId\n        name\n        l0Class\n        lastSeen\n        daysSinceLast\n        medianIntervalDays\n        dueInDays\n        window\n        overdue\n        scheduledDate\n        confidence\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetTimelineEvents($from: DateTime!, $to: DateTime!) {\n    eventsInRange(from: $from, to: $to) {\n      id\n      title\n      description\n      startTime\n      endTime\n      isAllDay\n      status\n      category\n      locationName\n      sourceSystem\n      externalSyncStatus\n      metadata\n    }\n  }\n"): (typeof documents)["\n  query GetTimelineEvents($from: DateTime!, $to: DateTime!) {\n    eventsInRange(from: $from, to: $to) {\n      id\n      title\n      description\n      startTime\n      endTime\n      isAllDay\n      status\n      category\n      locationName\n      sourceSystem\n      externalSyncStatus\n      metadata\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetTags {\n    tags {\n      edges {\n        node {\n          id\n          label\n          description\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetTags {\n    tags {\n      edges {\n        node {\n          id\n          label\n          description\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query WhatBarEventTypes {\n    eventTypes\n  }\n"): (typeof documents)["\n  query WhatBarEventTypes {\n    eventTypes\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query EventSources {\n    eventSources\n  }\n"): (typeof documents)["\n  query EventSources {\n    eventSources\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query EventTypes {\n    eventTypes\n  }\n"): (typeof documents)["\n  query EventTypes {\n    eventTypes\n  }\n"];
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
export function gql(source: "\n  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $semantic: Boolean) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, semantic: $semantic }) {\n      matchingTags {\n        id\n        label\n      }\n\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          # Unmasked names so the header box can attach a who/where filter\n          # payload to person/place rows (arrow-key add/remove) without\n          # per-item useFragment. Aliased to stay clear of the result\n          # fragments' own selections.\n          ... on PersonType {\n            filterName: name\n          }\n\n          ... on PlaceType {\n            filterName: name\n          }\n\n          ...SearchResultCommunicationData\n          ...SearchResultConceptData\n          ...SearchResultContentData\n          ...SearchResultEventData\n          ...SearchResultFileData\n          ...SearchResultItemData\n          ...SearchResultNoteData\n          ...SearchResultPersonData\n          ...SearchResultPlaceData\n          ...SearchResultThreadData\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $semantic: Boolean) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, semantic: $semantic }) {\n      matchingTags {\n        id\n        label\n      }\n\n      edges {\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          # Unmasked names so the header box can attach a who/where filter\n          # payload to person/place rows (arrow-key add/remove) without\n          # per-item useFragment. Aliased to stay clear of the result\n          # fragments' own selections.\n          ... on PersonType {\n            filterName: name\n          }\n\n          ... on PlaceType {\n            filterName: name\n          }\n\n          ...SearchResultCommunicationData\n          ...SearchResultConceptData\n          ...SearchResultContentData\n          ...SearchResultEventData\n          ...SearchResultFileData\n          ...SearchResultItemData\n          ...SearchResultNoteData\n          ...SearchResultPersonData\n          ...SearchResultPlaceData\n          ...SearchResultThreadData\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetConnections {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          accountLabel\n          provider {\n            id\n            name\n            localOnly\n            endpoints {\n              name\n              description\n            }\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n"): (typeof documents)["\n  query GetConnections {\n    connections {\n      edges {\n        cursor\n        node {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          accountLabel\n          provider {\n            id\n            name\n            localOnly\n            endpoints {\n              name\n              description\n            }\n          }\n        }\n      }\n      pageInfo {\n        hasNextPage\n        hasPreviousPage\n        startCursor\n        endCursor\n      }\n      totalCount\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetConnectionsForOnboarding {\n    connections {\n      edges {\n        node {\n          id\n          name\n          active\n          needsReauth\n          providerId\n          syncState\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetConnectionsForOnboarding {\n    connections {\n      edges {\n        node {\n          id\n          name\n          active\n          needsReauth\n          providerId\n          syncState\n        }\n      }\n    }\n  }\n"];
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
export function gql(source: "\n  fragment CommunicationGridItemData on CommunicationType {\n    id\n    subject\n    preview\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n  }\n"): (typeof documents)["\n  fragment CommunicationGridItemData on CommunicationType {\n    id\n    subject\n    preview\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ConceptGridItemData on ConceptType {\n    id\n    name\n    description\n  }\n"): (typeof documents)["\n  fragment ConceptGridItemData on ConceptType {\n    id\n    name\n    description\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ContentGridItemData on ContentType {\n    id\n    title\n    text\n    contentUrl: url\n    sourceUrl\n    mimetype\n  }\n"): (typeof documents)["\n  fragment ContentGridItemData on ContentType {\n    id\n    title\n    text\n    contentUrl: url\n    sourceUrl\n    mimetype\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment EventGridItemData on EventType {\n    id\n    title\n    description\n    startTime\n    eventType\n    locationName\n    sourceSystem\n  }\n"): (typeof documents)["\n  fragment EventGridItemData on EventType {\n    id\n    title\n    description\n    startTime\n    eventType\n    locationName\n    sourceSystem\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment FileChunkGridItemData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    file {\n      id\n      filename\n    }\n  }\n"): (typeof documents)["\n  fragment FileChunkGridItemData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    file {\n      id\n      filename\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment FileGridItemData on FileType {\n    id\n    filename\n    previewUrl\n    contentType\n    sourceUrl\n    title\n    description\n    size\n    createdAt\n  }\n"): (typeof documents)["\n  fragment FileGridItemData on FileType {\n    id\n    filename\n    previewUrl\n    contentType\n    sourceUrl\n    title\n    description\n    size\n    createdAt\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment ItemGridItemData on ItemType {\n    id\n    name\n    description\n    category\n    brand\n    model\n    currentValue\n    file {\n      id\n      sourceUrl\n    }\n  }\n"): (typeof documents)["\n  fragment ItemGridItemData on ItemType {\n    id\n    name\n    description\n    category\n    brand\n    model\n    currentValue\n    file {\n      id\n      sourceUrl\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment NoteGridItemData on NoteType {\n    id\n    title\n    content\n    createdAt\n  }\n"): (typeof documents)["\n  fragment NoteGridItemData on NoteType {\n    id\n    title\n    content\n    createdAt\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment PersonGridItemData on PersonType {\n    id\n    name\n    description\n    avatarUrl\n    firstName\n    lastName\n    birthDate\n  }\n"): (typeof documents)["\n  fragment PersonGridItemData on PersonType {\n    id\n    name\n    description\n    avatarUrl\n    firstName\n    lastName\n    birthDate\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment PlaceGridItemData on PlaceType {\n    id\n    name\n    description\n    properties\n  }\n"): (typeof documents)["\n  fragment PlaceGridItemData on PlaceType {\n    id\n    name\n    description\n    properties\n  }\n"];
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
export function gql(source: "\n  query GetUserData {\n    me {\n      id\n      name\n      email\n      onboarded\n      needsIdentityStep\n      timezone\n\n      entity {\n        id\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetUserData {\n    me {\n      id\n      name\n      email\n      onboarded\n      needsIdentityStep\n      timezone\n\n      entity {\n        id\n      }\n    }\n  }\n"];
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
export function gql(source: "\n  mutation UpdateConceptDescription($input: UpdateConceptInput!) {\n    updateConcept(input: $input) {\n      success\n      concept {\n        id\n        description\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateConceptDescription($input: UpdateConceptInput!) {\n    updateConcept(input: $input) {\n      success\n      concept {\n        id\n        description\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetConnection($id: ID!) {\n    connection(id: $id) {\n      id\n      name\n      active\n      schedule\n      tokenExpiry\n      syncState\n      activeEndpoints\n      providerId\n      needsReauth\n      externalId\n      accountLabel\n      provider {\n        id\n        name\n        authType\n        endpoints {\n          name\n          description\n          iterationType\n          TTL\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetConnection($id: ID!) {\n    connection(id: $id) {\n      id\n      name\n      active\n      schedule\n      tokenExpiry\n      syncState\n      activeEndpoints\n      providerId\n      needsReauth\n      externalId\n      accountLabel\n      provider {\n        id\n        name\n        authType\n        endpoints {\n          name\n          description\n          iterationType\n          TTL\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateConnection($input: UpdateConnectionInput!) {\n    updateConnection(input: $input) {\n      success\n      connection {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          accountLabel\n          provider {\n              id\n              name\n              authType\n              endpoints {\n                name\n                description\n                iterationType\n                TTL\n              }\n          }\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateConnection($input: UpdateConnectionInput!) {\n    updateConnection(input: $input) {\n      success\n      connection {\n          id\n          name\n          active\n          schedule\n          tokenExpiry\n          syncState\n          activeEndpoints\n          providerId\n          needsReauth\n          externalId\n          accountLabel\n          provider {\n              id\n              name\n              authType\n              endpoints {\n                name\n                description\n                iterationType\n                TTL\n              }\n          }\n      }\n    }\n  }\n"];
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
export function gql(source: "\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        id\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetContent($id: ID!) {\n    content(id: $id) {\n      id\n      title\n      text\n      tags {\n        id\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateContentText($input: UpdateContentInput!) {\n    updateContent(input: $input) {\n      id\n      text\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateContentText($input: UpdateContentInput!) {\n    updateContent(input: $input) {\n      id\n      text\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        id\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetEvent($id: ID!) {\n    event(id: $id) {\n      id\n      title\n      description\n\n      tags {\n        id\n        label\n      }\n\n      location {\n        id\n        name\n        properties\n      }\n\n      organizer {\n        id\n        name\n      }\n\n      participants {\n        edges {\n          node {\n            id\n            name\n          }\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateEventDescription($input: UpdateEventInput!) {\n    updateEvent(input: $input) {\n      id\n      description\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateEventDescription($input: UpdateEventInput!) {\n    updateEvent(input: $input) {\n      id\n      description\n    }\n  }\n"];
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
export function gql(source: "\n  mutation UpdateItemDescription($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      success\n      item {\n        id\n        description\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateItemDescription($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      success\n      item {\n        id\n        description\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query ActivityTimeline($start: String!, $end: String!, $filters: ActivityTimelineFiltersInput) {\n    activityTimeline(start: $start, end: $end, filters: $filters) {\n      date\n      count\n    }\n  }\n"): (typeof documents)["\n  query ActivityTimeline($start: String!, $end: String!, $filters: ActivityTimelineFiltersInput) {\n    activityTimeline(start: $start, end: $end, filters: $filters) {\n      date\n      count\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TimelineBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n    actionType\n    duration\n    time\n    tags {\n      label\n    }\n  }\n"): (typeof documents)["\n  fragment TimelineBrowserActivityCardData on BrowserActivityType {\n    id\n    title\n    url\n    actionType\n    duration\n    time\n    tags {\n      label\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TimelineCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n    communicationContent: content\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n    to {\n      edges {\n        node {\n          id\n          name\n        }\n      }\n    }\n    tags {\n      label\n    }\n  }\n"): (typeof documents)["\n  fragment TimelineCommunicationCardData on CommunicationType {\n    id\n    subject\n    preview\n    communicationContent: content\n    time\n    type\n    direction\n    from {\n      id\n      name\n    }\n    to {\n      edges {\n        node {\n          id\n          name\n        }\n      }\n    }\n    tags {\n      label\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TimelineEventCardData on EventType {\n    id\n    title\n    description\n    sourceSystem\n    startTime\n    endTime\n    locationName\n    location {\n      ... on PlaceType {\n        id\n        name\n        properties\n      }\n    }\n    previewUrl\n    mediaUrl\n    mediaContentType\n    mediaWidth\n    mediaHeight\n    mediaSize\n    tags {\n      label\n    }\n  }\n"): (typeof documents)["\n  fragment TimelineEventCardData on EventType {\n    id\n    title\n    description\n    sourceSystem\n    startTime\n    endTime\n    locationName\n    location {\n      ... on PlaceType {\n        id\n        name\n        properties\n      }\n    }\n    previewUrl\n    mediaUrl\n    mediaContentType\n    mediaWidth\n    mediaHeight\n    mediaSize\n    tags {\n      label\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TimelineFileChunkCardData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    createdAt\n    file {\n      id\n      filename\n      sourceUrl\n    }\n  }\n"): (typeof documents)["\n  fragment TimelineFileChunkCardData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    createdAt\n    file {\n      id\n      filename\n      sourceUrl\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateBrowserActivityDetail($input: UpdateBrowserActivityInput!) {\n    updateBrowserActivity(input: $input) {\n      id\n      title\n      url\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateBrowserActivityDetail($input: UpdateBrowserActivityInput!) {\n    updateBrowserActivity(input: $input) {\n      id\n      title\n      url\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateCommunicationDetail($input: UpdateCommunicationInput!) {\n    updateCommunication(input: $input) {\n      id\n      subject\n      preview\n      communicationContent: content\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateCommunicationDetail($input: UpdateCommunicationInput!) {\n    updateCommunication(input: $input) {\n      id\n      subject\n      preview\n      communicationContent: content\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateConceptDetail($input: UpdateConceptInput!) {\n    updateConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateConceptDetail($input: UpdateConceptInput!) {\n    updateConcept(input: $input) {\n      success\n      concept {\n        id\n        name\n        description\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateContentDetail($input: UpdateContentInput!) {\n    updateContent(input: $input) {\n      id\n      title\n      text\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateContentDetail($input: UpdateContentInput!) {\n    updateContent(input: $input) {\n      id\n      title\n      text\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateEventDetail($input: UpdateEventInput!) {\n    updateEvent(input: $input) {\n      id\n      title\n      description\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateEventDetail($input: UpdateEventInput!) {\n    updateEvent(input: $input) {\n      id\n      title\n      description\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateFileDetail($input: UpdateFileInput!) {\n    updateFile(input: $input) {\n      id\n      title\n      description\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateFileDetail($input: UpdateFileInput!) {\n    updateFile(input: $input) {\n      id\n      title\n      description\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateItemDetail($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      success\n      item {\n        id\n        name\n        description\n        category\n        brand\n        model\n        currentValue\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateItemDetail($input: UpdateItemInput!) {\n    updateItem(input: $input) {\n      success\n      item {\n        id\n        name\n        description\n        category\n        brand\n        model\n        currentValue\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateNoteDetail($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateNoteDetail($input: UpdateNoteInput!) {\n    updateNote(input: $input) {\n      success\n      note {\n        id\n        title\n        content\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdatePersonDetail($input: UpdatePersonInput!) {\n    updatePerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n        firstName\n        lastName\n        birthDate\n        avatarUrl\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdatePersonDetail($input: UpdatePersonInput!) {\n    updatePerson(input: $input) {\n      success\n      person {\n        id\n        name\n        description\n        firstName\n        lastName\n        birthDate\n        avatarUrl\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdatePlaceDetail($input: UpdatePlaceInput!) {\n    updatePlace(input: $input) {\n      id\n      name\n      description\n      properties\n    }\n  }\n"): (typeof documents)["\n  mutation UpdatePlaceDetail($input: UpdatePlaceInput!) {\n    updatePlace(input: $input) {\n      id\n      name\n      description\n      properties\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n      filters {\n        eventTypes\n        startTime\n        endTime\n        datePreset\n        sortBy\n        sortOrder\n        connectors\n        people\n        places\n        hasLocation\n        semantic\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetSavedSearch($id: ID!) {\n    savedSearch(id: $id) {\n      id\n      name\n      description\n      query\n      entityTypes\n      tags\n      filters {\n        eventTypes\n        startTime\n        endTime\n        datePreset\n        sortBy\n        sortOrder\n        connectors\n        people\n        places\n        hasLocation\n        semantic\n      }\n    }\n  }\n"];
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
export function gql(source: "\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n    startTime\n    locationName\n    previewUrl\n    mediaContentType\n  }\n"): (typeof documents)["\n  fragment TableEventRowData on EventType {\n    id\n    title\n    description\n    startTime\n    locationName\n    previewUrl\n    mediaContentType\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableFileChunkRowData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    file {\n      id\n      filename\n    }\n  }\n"): (typeof documents)["\n  fragment TableFileChunkRowData on FileChunkType {\n    id\n    sectionTitle\n    chunkContent: content\n    sourceLocator\n    file {\n      id\n      filename\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TableFileRowData on FileType {\n    id\n    filename\n    title\n    previewUrl\n    sourceUrl\n    contentType\n  }\n"): (typeof documents)["\n  fragment TableFileRowData on FileType {\n    id\n    filename\n    title\n    previewUrl\n    sourceUrl\n    contentType\n  }\n"];
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
export function gql(source: "\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $includeFiles: Boolean, $eventTypes: [String!], $tags: [String!], $startTime: String, $endTime: String, $sortBy: String, $sortOrder: String, $connectors: [String!], $people: [String!], $places: [String!], $hasLocation: Boolean, $bbox: [Float!], $semantic: Boolean, $shareToken: String, $first: Int, $after: String) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, includeFiles: $includeFiles, eventTypes: $eventTypes, tags: $tags, startTime: $startTime, endTime: $endTime, sortBy: $sortBy, sortOrder: $sortOrder, connectors: $connectors, people: $people, places: $places, hasLocation: $hasLocation, bbox: $bbox, semantic: $semantic, shareToken: $shareToken, first: $first, after: $after }) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ... on Taggable {\n            tags {\n              label\n            }\n          }\n\n          # Unmasked media fields so the gallery can build real thumbnails and a\n          # cross-item lightbox without per-item useFragment calls. Aliased to\n          # stay clear of the grid fragments' own selections.\n          ... on FileType {\n            galleryContentType: contentType\n            galleryFilename: filename\n            galleryPreviewUrl: previewUrl\n            gallerySourceUrl: sourceUrl\n          }\n\n          ... on ContentType {\n            galleryMimetype: mimetype\n            galleryTitle: title\n            galleryContentUrl: url\n            galleryContentSourceUrl: sourceUrl\n          }\n\n          ...AnswerGridItemData\n          ...BrowserActivityGridItemData\n          ...CommunicationGridItemData\n          ...ConceptGridItemData\n          ...ContentGridItemData\n          ...EventGridItemData\n          ...FileChunkGridItemData\n          ...FileGridItemData\n          ...NoteGridItemData\n          ...ItemGridItemData\n          ...PersonGridItemData\n          ...PlaceGridItemData\n          ...ThreadGridItemData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileChunkRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n\n          ...TimelineBrowserActivityCardData\n          ...TimelineCommunicationCardData\n          ...TimelineEventCardData\n\n          # Aliased timestamps so date-grouping (getEntityTimestamp) can read the\n          # field the server sorts by without unmasking spread fragments. Mirrors\n          # SearchResolver.getEntityTimestamp (time ?? startTime).\n          ... on CommunicationType {\n            bucketTime: time\n          }\n\n          ... on BrowserActivityType {\n            bucketTime: time\n          }\n\n          ... on EventType {\n            bucketStartTime: startTime\n            # The event's kind (visited / messaged / traveled / …), unmasked so\n            # the Events tab can group its timeline by activity without\n            # unmasking the card fragment.\n            eventType\n            # Coordinates for the map. Events carry a PostGIS Point in\n            # locationCoordinates (GeoJSON [lng, lat]) even with no resolved\n            # location PlaceType; aliased + unmasked so the map can read it\n            # without unmasking the card fragment.\n            mapCoordinates: locationCoordinates\n\n            # Photo/video events carry their binary via a linked file; these\n            # aliased media fields let the gallery build real thumbnails + a\n            # lightbox (mirrors FileType/ContentType above). Null for non-media\n            # events. galleryLocationName feeds the derived \"Photo · place ·\n            # date\" tile caption (eventDisplayTitle).\n            # Distinct content-type alias: FileType.contentType is String! but\n            # EventType.mediaContentType is nullable String, so they can't share\n            # the galleryContentType response key (overlapping-fields rule).\n            galleryMediaContentType: mediaContentType\n            galleryPreviewUrl: previewUrl\n            gallerySourceUrl: mediaUrl\n            galleryTitle: title\n            galleryLocationName: locationName\n          }\n\n          ... on PlaceType {\n            mapProperties: properties\n          }\n\n          ...TimelineFileChunkCardData\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $includeFiles: Boolean, $eventTypes: [String!], $tags: [String!], $startTime: String, $endTime: String, $sortBy: String, $sortOrder: String, $connectors: [String!], $people: [String!], $places: [String!], $hasLocation: Boolean, $bbox: [Float!], $semantic: Boolean, $shareToken: String, $first: Int, $after: String) {\n    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, includeFiles: $includeFiles, eventTypes: $eventTypes, tags: $tags, startTime: $startTime, endTime: $endTime, sortBy: $sortBy, sortOrder: $sortOrder, connectors: $connectors, people: $people, places: $places, hasLocation: $hasLocation, bbox: $bbox, semantic: $semantic, shareToken: $shareToken, first: $first, after: $after }) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          __typename\n\n          ... on Node {\n            id\n          }\n\n          ... on Taggable {\n            tags {\n              label\n            }\n          }\n\n          # Unmasked media fields so the gallery can build real thumbnails and a\n          # cross-item lightbox without per-item useFragment calls. Aliased to\n          # stay clear of the grid fragments' own selections.\n          ... on FileType {\n            galleryContentType: contentType\n            galleryFilename: filename\n            galleryPreviewUrl: previewUrl\n            gallerySourceUrl: sourceUrl\n          }\n\n          ... on ContentType {\n            galleryMimetype: mimetype\n            galleryTitle: title\n            galleryContentUrl: url\n            galleryContentSourceUrl: sourceUrl\n          }\n\n          ...AnswerGridItemData\n          ...BrowserActivityGridItemData\n          ...CommunicationGridItemData\n          ...ConceptGridItemData\n          ...ContentGridItemData\n          ...EventGridItemData\n          ...FileChunkGridItemData\n          ...FileGridItemData\n          ...NoteGridItemData\n          ...ItemGridItemData\n          ...PersonGridItemData\n          ...PlaceGridItemData\n          ...ThreadGridItemData\n\n          ...TableAnswerRowData\n          ...TableCommunicationRowData\n          ...TableConceptRowData\n          ...TableContentRowData\n          ...TableEventRowData\n          ...TableFileChunkRowData\n          ...TableFileRowData\n          ...TableItemRowData\n          ...TableNoteRowData\n          ...TablePersonRowData\n          ...TablePlaceRowData\n          ...TableThreadRowData\n          ...TableBrowserActivityRowData\n\n          ...TimelineBrowserActivityCardData\n          ...TimelineCommunicationCardData\n          ...TimelineEventCardData\n\n          # Aliased timestamps so date-grouping (getEntityTimestamp) can read the\n          # field the server sorts by without unmasking spread fragments. Mirrors\n          # SearchResolver.getEntityTimestamp (time ?? startTime).\n          ... on CommunicationType {\n            bucketTime: time\n          }\n\n          ... on BrowserActivityType {\n            bucketTime: time\n          }\n\n          ... on EventType {\n            bucketStartTime: startTime\n            # The event's kind (visited / messaged / traveled / …), unmasked so\n            # the Events tab can group its timeline by activity without\n            # unmasking the card fragment.\n            eventType\n            # Coordinates for the map. Events carry a PostGIS Point in\n            # locationCoordinates (GeoJSON [lng, lat]) even with no resolved\n            # location PlaceType; aliased + unmasked so the map can read it\n            # without unmasking the card fragment.\n            mapCoordinates: locationCoordinates\n\n            # Photo/video events carry their binary via a linked file; these\n            # aliased media fields let the gallery build real thumbnails + a\n            # lightbox (mirrors FileType/ContentType above). Null for non-media\n            # events. galleryLocationName feeds the derived \"Photo · place ·\n            # date\" tile caption (eventDisplayTitle).\n            # Distinct content-type alias: FileType.contentType is String! but\n            # EventType.mediaContentType is nullable String, so they can't share\n            # the galleryContentType response key (overlapping-fields rule).\n            galleryMediaContentType: mediaContentType\n            galleryPreviewUrl: previewUrl\n            gallerySourceUrl: mediaUrl\n            galleryTitle: title\n            galleryLocationName: locationName\n          }\n\n          ... on PlaceType {\n            mapProperties: properties\n          }\n\n          ...TimelineFileChunkCardData\n        }\n      }\n    }\n  }\n"];
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
export function gql(source: "\n  query GetPeople($query: String, $first: Int, $after: String) {\n    people(query: $query, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          name\n          description\n          firstName\n          lastName\n          avatarUrl\n          birthDate\n          isSelf\n          identifiers {\n            kind\n            value\n            label\n          }\n          interactionStats {\n            eventCount\n            communicationCount\n            lastInteractionAt\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetPeople($query: String, $first: Int, $after: String) {\n    people(query: $query, first: $first, after: $after) {\n      totalCount\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n      edges {\n        cursor\n        node {\n          id\n          name\n          description\n          firstName\n          lastName\n          avatarUrl\n          birthDate\n          isSelf\n          identifiers {\n            kind\n            value\n            label\n          }\n          interactionStats {\n            eventCount\n            communicationCount\n            lastInteractionAt\n          }\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetPersonDuplicates {\n    personDuplicates {\n      reason\n      value\n      people {\n        id\n        name\n        description\n        avatarUrl\n        isSelf\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetPersonDuplicates {\n    personDuplicates {\n      reason\n      value\n      people {\n        id\n        name\n        description\n        avatarUrl\n        isSelf\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation MergePeople($input: MergePeopleInput!) {\n    mergePeople(input: $input) {\n      success\n      person {\n        id\n        name\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation MergePeople($input: MergePeopleInput!) {\n    mergePeople(input: $input) {\n      success\n      person {\n        id\n        name\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation RejectPersonDuplicates($personIds: [ID!]!) {\n    rejectPersonDuplicates(personIds: $personIds)\n  }\n"): (typeof documents)["\n  mutation RejectPersonDuplicates($personIds: [ID!]!) {\n    rejectPersonDuplicates(personIds: $personIds)\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetPerson($id: ID!) {\n    person(id: $id) {\n      id\n      name\n      description\n      tags {\n        id\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdatePersonDescription($input: UpdatePersonInput!) {\n    updatePerson(input: $input) {\n      success\n      person {\n        id\n        description\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdatePersonDescription($input: UpdatePersonInput!) {\n    updatePerson(input: $input) {\n      success\n      person {\n        id\n        description\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        id\n        label\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetPlace($id: ID!) {\n    place(id: $id) {\n      id\n      name\n      description\n      properties\n      tags {\n        id\n        label\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdatePlaceDescription($input: UpdatePlaceInput!) {\n    updatePlace(input: $input) {\n      id\n      description\n    }\n  }\n"): (typeof documents)["\n  mutation UpdatePlaceDescription($input: UpdatePlaceInput!) {\n    updatePlace(input: $input) {\n      id\n      description\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetPlaces($query: String) {\n    places(query: $query, first: 500) {\n      totalCount\n      edges {\n        node {\n          id\n          name\n          description\n          placeKind\n          latitude\n          longitude\n          parent {\n            id\n            name\n            placeKind\n          }\n          visitStats {\n            visitCount\n            firstVisitAt\n            lastVisitAt\n          }\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetPlaces($query: String) {\n    places(query: $query, first: 500) {\n      totalCount\n      edges {\n        node {\n          id\n          name\n          description\n          placeKind\n          latitude\n          longitude\n          parent {\n            id\n            name\n            placeKind\n          }\n          visitStats {\n            visitCount\n            firstVisitAt\n            lastVisitAt\n          }\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetKnownPlaces {\n    knownPlaces {\n      id\n      locationId\n      label\n      kind\n      confidence\n      source\n      coordinates {\n        lat\n        lng\n      }\n    }\n    knownPlaceCandidates {\n      locationId\n      label\n      kind\n      lat\n      lng\n      eventCount\n      confidence\n    }\n  }\n"): (typeof documents)["\n  query GetKnownPlaces {\n    knownPlaces {\n      id\n      locationId\n      label\n      kind\n      confidence\n      source\n      coordinates {\n        lat\n        lng\n      }\n    }\n    knownPlaceCandidates {\n      locationId\n      label\n      kind\n      lat\n      lng\n      eventCount\n      confidence\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation ConfirmKnownPlace($input: UpdateKnownPlaceInput!) {\n    updateKnownPlace(input: $input) {\n      id\n      label\n      kind\n    }\n  }\n"): (typeof documents)["\n  mutation ConfirmKnownPlace($input: UpdateKnownPlaceInput!) {\n    updateKnownPlace(input: $input) {\n      id\n      label\n      kind\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation DeleteTask($input: DeleteByIdInput!) {\n    deleteTask(input: $input) {\n      success\n      deletedId\n    }\n  }\n"): (typeof documents)["\n  mutation DeleteTask($input: DeleteByIdInput!) {\n    deleteTask(input: $input) {\n      success\n      deletedId\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation CreateTask($input: CreateTaskInput!) {\n    createTask(input: $input) {\n      success\n      task {\n        id\n        ...TaskRowFragment\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation CreateTask($input: CreateTaskInput!) {\n    createTask(input: $input) {\n      success\n      task {\n        id\n        ...TaskRowFragment\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetTasks($first: Int, $after: String) {\n    tasks(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          status\n          priority\n          dueAt\n          scheduledFor\n          deferUntil\n          title\n          ...TaskRowFragment\n        }\n      }\n      totalCount\n    }\n  }\n"): (typeof documents)["\n  query GetTasks($first: Int, $after: String) {\n    tasks(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          status\n          priority\n          dueAt\n          scheduledFor\n          deferUntil\n          title\n          ...TaskRowFragment\n        }\n      }\n      totalCount\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation CompleteTask($id: ID!) {\n    completeTask(id: $id) {\n      id\n      status\n      completedAt\n    }\n  }\n"): (typeof documents)["\n  mutation CompleteTask($id: ID!) {\n    completeTask(id: $id) {\n      id\n      status\n      completedAt\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation ReopenTask($id: ID!) {\n    reopenTask(id: $id) {\n      id\n      status\n      completedAt\n    }\n  }\n"): (typeof documents)["\n  mutation ReopenTask($id: ID!) {\n    reopenTask(id: $id) {\n      id\n      status\n      completedAt\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment TaskRowFragment on TaskType {\n    id\n    title\n    description\n    status\n    priority\n    dueAt\n    scheduledFor\n    deferUntil\n    estimatedMinutes\n    completedAt\n  }\n"): (typeof documents)["\n  fragment TaskRowFragment on TaskType {\n    id\n    title\n    description\n    status\n    priority\n    dueAt\n    scheduledFor\n    deferUntil\n    estimatedMinutes\n    completedAt\n  }\n"];
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
export function gql(source: "\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        # Full grid fragment (incl. isPublic/shareToken/filters) so the created\n        # search can be handed straight to the share modal from \"Save & share\".\n        ...SavedSearchGridItemFragment\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation CreateSavedSearch($input: CreateSavedSearchInput!) {\n    createSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        # Full grid fragment (incl. isPublic/shareToken/filters) so the created\n        # search can be handed straight to the share modal from \"Save & share\".\n        ...SavedSearchGridItemFragment\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n"): (typeof documents)["\n  mutation DeleteSavedSearch($input: DeleteByIdInput!) {\n    deleteSavedSearch(input: $input) {\n      success\n      deletedId\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n        filters {\n          eventTypes\n          startTime\n          endTime\n          datePreset\n          sortBy\n          sortOrder\n          connectors\n          people\n          places\n          hasLocation\n          semantic\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateSavedSearch($input: UpdateSavedSearchInput!) {\n    updateSavedSearch(input: $input) {\n      success\n      savedSearch {\n        id\n        name\n        description\n        query\n        entityTypes\n        tags\n        filters {\n          eventTypes\n          startTime\n          endTime\n          datePreset\n          sortBy\n          sortOrder\n          connectors\n          people\n          places\n          hasLocation\n          semantic\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n    filters {\n      eventTypes\n      startTime\n      endTime\n      datePreset\n      sortBy\n      sortOrder\n      connectors\n      people\n      places\n      hasLocation\n      semantic\n    }\n    isPublic\n    shareToken\n  }\n"): (typeof documents)["\n  fragment SavedSearchGridItemFragment on SavedSearchType {\n    id\n    name\n    description\n    query\n    entityTypes\n    tags\n    filters {\n      eventTypes\n      startTime\n      endTime\n      datePreset\n      sortBy\n      sortOrder\n      connectors\n      people\n      places\n      hasLocation\n      semantic\n    }\n    isPublic\n    shareToken\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n"): (typeof documents)["\n  query GetSavedSearches($first: Int, $after: String) {\n    savedSearches(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          ...SavedSearchGridItemFragment\n        }\n      }\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  mutation SetSavedSearchSharing($input: SetSavedSearchSharingInput!) {\n    setSavedSearchSharing(input: $input) {\n      success\n      savedSearch {\n        id\n        # Spread keeps the grid card's cache entry in sync (the \"Shared\" badge);\n        # the top-level isPublic/shareToken are unmasked so this modal can show\n        # the freshly minted link without reopening (useFragment is not reactive).\n        isPublic\n        shareToken\n        ...SavedSearchGridItemFragment\n      }\n    }\n  }\n"): (typeof documents)["\n  mutation SetSavedSearchSharing($input: SetSavedSearchSharingInput!) {\n    setSavedSearchSharing(input: $input) {\n      success\n      savedSearch {\n        id\n        # Spread keeps the grid card's cache entry in sync (the \"Shared\" badge);\n        # the top-level isPublic/shareToken are unmasked so this modal can show\n        # the freshly minted link without reopening (useFragment is not reactive).\n        isPublic\n        shareToken\n        ...SavedSearchGridItemFragment\n      }\n    }\n  }\n"];
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
export function gql(source: "\n  mutation UpdateCurrentUserTimezone($input: UpdateCurrentUserInput!) {\n    updateCurrentUser(input: $input) {\n      id\n      timezone\n    }\n  }\n"): (typeof documents)["\n  mutation UpdateCurrentUserTimezone($input: UpdateCurrentUserInput!) {\n    updateCurrentUser(input: $input) {\n      id\n      timezone\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSharedSavedSearch($token: String!) {\n    sharedSavedSearch(token: $token) {\n      id\n      name\n      description\n    }\n  }\n"): (typeof documents)["\n  query GetSharedSavedSearch($token: String!) {\n    sharedSavedSearch(token: $token) {\n      id\n      name\n      description\n    }\n  }\n"];
/**
 * The gql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function gql(source: "\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      insights {\n        title\n        summaryText\n        keyActions\n        relevanceScore\n        tags\n        relatedEntityIds\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n"): (typeof documents)["\n  query GetSummary($id: ID!) {\n    summary(id: $id) {\n      id\n      title\n      periodType\n      periodStart\n      periodEnd\n      summaryText\n      keyInsights\n      notableEvents\n      anomalies\n      tags\n      activityCounts {\n        total\n        browserActivity\n        communications\n        files\n        events\n        messages\n        screenCaptures\n        apiLogs\n        positions\n        activities\n        measurements\n      }\n      insights {\n        title\n        summaryText\n        keyActions\n        relevanceScore\n        tags\n        relatedEntityIds\n      }\n      dailyRhythm\n      productivityPatterns\n      socialInteractions\n      keyAccomplishments\n      moodIndicators\n      confidenceScore\n      createdAt\n      updatedAt\n    }\n  }\n"];
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
