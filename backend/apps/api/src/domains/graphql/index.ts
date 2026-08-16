import path from 'node:path';

import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';

import { ActivityModule } from '@ci/domains/activity';
import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConnectionsModule } from '@ci/domains/connections';
import { ConversationModule } from '@ci/domains/conversations';
import { DeviceModule } from '@ci/domains/devices';
import { EntityResolutionModule } from '@ci/domains/entity-resolution';
import { EtlModule } from '@ci/domains/etl';
import { FilesModule } from '@ci/domains/files';
import { GraphModule } from '@ci/domains/graph';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { PairingModule } from '@ci/domains/pairing';
import { ParsingModule } from '@ci/domains/parsing';
import { PlanningModule } from '@ci/domains/planning';
import { PredictionsModule } from '@ci/domains/predictions';
import { PythonFunctionsModule } from '@ci/domains/python-functions';
import { ScheduleModule } from '@ci/domains/schedule';
import { SearchNextModule } from '@ci/domains/search-next';
import { SummariesModule } from '@ci/domains/summaries';
import { UserModule } from '@ci/domains/user';
import { UserSnapshotsModule } from '@ci/domains/user-snapshots';

import { GraphQLController } from './controllers/GraphQLController';
import { ConnectionLoader } from './loaders/ConnectionLoader';
import { EventContentsLoader } from './loaders/EventContentsLoader';
import { EventLoader } from './loaders/EventLoader';
import { EventMediaLoader } from './loaders/EventMediaLoader';
import { FileItemsLoader } from './loaders/FileItemsLoader';
import { ItemFileLoader } from './loaders/ItemFileLoader';
import { PersonIdentifiersLoader } from './loaders/PersonIdentifiersLoader';
import { PersonInteractionStatsLoader } from './loaders/PersonInteractionStatsLoader';
import { PersonLoader } from './loaders/PersonLoader';
import { PlaceLoader } from './loaders/PlaceLoader';
import { PlaceVisitStatsLoader } from './loaders/PlaceVisitStatsLoader';
import { PreviewLoader } from './loaders/PreviewLoader';
import { ProviderKeyLoader } from './loaders/ProviderKeyLoader';
import { ProviderLoader } from './loaders/ProviderLoader';
import { QuestionLoader } from './loaders/QuestionLoader';
import { TagLoader } from './loaders/TagLoader';
import { ThreadLoader } from './loaders/ThreadLoader';
import { ThreadMessagesLoader } from './loaders/ThreadMessagesLoader';
import { ComplexityPlugin } from './plugins/ComplexityPlugin';
import { ActionResolver } from './resolvers/ActionResolver';
import { ActivityResolver } from './resolvers/ActivityResolver';
import { AnswerResolver } from './resolvers/AnswerResolver';
import { BrowserActivityResolver } from './resolvers/BrowserActivityResolver';
import { CommunicationResolver } from './resolvers/CommunicationResolver';
import { ConceptResolver } from './resolvers/ConceptResolver';
import { ConnectionResolver } from './resolvers/ConnectionResolver';
import { ConnectionSyncJobResolver } from './resolvers/ConnectionSyncJobResolver';
import { ContentResolver } from './resolvers/ContentResolver';
import { EventResolver } from './resolvers/EventResolver';
import { FileResolver } from './resolvers/FileResolver';
import { ForecastResolver } from './resolvers/ForecastResolver';
import { GraphIngestResolver } from './resolvers/GraphIngestResolver';
import { GraphResolver } from './resolvers/GraphResolver';
import { ItemRelationshipResolver } from './resolvers/ItemRelationshipResolver';
import { ItemResolver } from './resolvers/ItemResolver';
import { KnownPlacesResolver } from './resolvers/KnownPlacesResolver';
import { NodeResolver } from './resolvers/NodeResolver';
import { NoteResolver } from './resolvers/NoteResolver';
import { PairingResolver } from './resolvers/PairingResolver';
import { PersonResolver } from './resolvers/PersonResolver';
import { PlaceResolver } from './resolvers/PlaceResolver';
import { ProviderKeyResolver } from './resolvers/ProviderKeyResolver';
import { ProviderResolver } from './resolvers/ProviderResolver';
import { QuestionResolver } from './resolvers/QuestionResolver';
import { RelationshipResolver } from './resolvers/RelationshipResolver';
import { SavedSearchResolver } from './resolvers/SavedSearchResolver';
import { ScheduleCandidateResolver } from './resolvers/ScheduleCandidateResolver';
import { SearchResolver } from './resolvers/SearchResolver';
import { SummaryResolver } from './resolvers/SummaryResolver';
import { TagResolver } from './resolvers/TagResolver';
import { TaskResolver } from './resolvers/TaskResolver';
import { ThreadResolver } from './resolvers/ThreadResolver';
import { UserResolver } from './resolvers/UserResolver';
import { UserSnapshotResolver } from './resolvers/UserSnapshotResolver';

@Module({
  imports: [
    NestGraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: path.join(__dirname, '__generated__/schema.graphql'),
      sortSchema: true,
      playground: false,
      // Introspection is a development affordance, and it was on unconditionally
      // — so an UNAUTHENTICATED caller on the LAN could enumerate the entire
      // schema (64 root fields, every type and argument) from an appliance
      // holding one person's whole life. The resolvers themselves are guarded
      // and refuse anonymous reads, so this is disclosure rather than access:
      // it hands an attacker the map without the keys. Off in production, on
      // everywhere else, matching how `configuration.ts` gates the other
      // "fine in dev, never in a real deployment" behaviours.
      introspection: process.env.NODE_ENV !== 'production',
      graphiql: false,
    }),
    PairingModule,
    ActivityModule,
    BrowserActivityModule,
    ConnectionsModule,
    DeviceModule,
    PredictionsModule,
    PythonFunctionsModule,
    ConversationModule,
    EntityResolutionModule,
    EtlModule,
    FilesModule,
    GraphModule,
    IntelligenceModule,
    MemoryModule,
    NotesModule,
    ParsingModule,
    PlanningModule,
    SearchNextModule,
    ScheduleModule,
    SummariesModule,
    UserModule,
    UserSnapshotsModule,
  ],
  providers: [
    ActionResolver,
    ActivityResolver,
    ForecastResolver,
    ScheduleCandidateResolver,
    PairingResolver,
    BrowserActivityResolver,
    CommunicationResolver,
    ComplexityPlugin,
    ConceptResolver,
    ConnectionLoader,
    ConnectionResolver,
    ConnectionSyncJobResolver,
    ContentResolver,
    NodeResolver,
    NoteResolver,
    TaskResolver,
    AnswerResolver,
    EventContentsLoader,
    EventLoader,
    EventMediaLoader,
    EventResolver,
    FileItemsLoader,
    FileResolver,
    GraphIngestResolver,
    GraphResolver,
    ItemFileLoader,
    ItemRelationshipResolver,
    ItemResolver,
    KnownPlacesResolver,
    PersonIdentifiersLoader,
    PersonInteractionStatsLoader,
    PersonLoader,
    PersonResolver,
    PlaceLoader,
    PlaceVisitStatsLoader,
    PlaceResolver,
    PreviewLoader,
    ProviderResolver,
    ProviderKeyLoader,
    ProviderKeyResolver,
    ProviderLoader,
    QuestionLoader,
    QuestionResolver,
    RelationshipResolver,
    SavedSearchResolver,
    SearchResolver,
    SummaryResolver,
    TagLoader,
    TagResolver,
    ThreadLoader,
    ThreadMessagesLoader,
    ThreadResolver,
    UserSnapshotResolver,
    UserResolver,
  ],
  controllers: [GraphQLController],
  exports: [NestGraphQLModule],
})
export class GraphQLModule {}
