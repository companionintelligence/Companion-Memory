import path from 'node:path';

import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityModule } from '@ci/domains/activity';
import { AgentModule } from '@ci/domains/agent';
import { AsksModule } from '@ci/domains/asks';
import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConnectionsModule } from '@ci/domains/connections';
import { ConversationModule } from '@ci/domains/conversations';
import { DailyMetricsModule } from '@ci/domains/daily-metrics';
import { DeviceModule } from '@ci/domains/devices';
import { EmbedModule } from '@ci/domains/embed';
import { EntityResolutionModule } from '@ci/domains/entity-resolution';
import { EtlModule } from '@ci/domains/etl';
import { FilesModule } from '@ci/domains/files';
import { GeocodeModule } from '@ci/domains/geocode';
import { GraphModule } from '@ci/domains/graph';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule, ObjectObservationEntity, ReceiptLineItemEntity } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { ParsingModule } from '@ci/domains/parsing';
import { PeersModule } from '@ci/domains/peers';
import { PlanningModule } from '@ci/domains/planning';
import { PositionModule } from '@ci/domains/position';
import { PredictionsModule } from '@ci/domains/predictions';
import { PrivacyModule } from '@ci/domains/privacy';
import { PythonFunctionsModule } from '@ci/domains/python-functions';
import { ScheduleModule } from '@ci/domains/schedule';
import { SearchNextModule } from '@ci/domains/search-next';
import { SummariesModule } from '@ci/domains/summaries';
import { UserModule } from '@ci/domains/user';

import { GraphQLController } from './controllers/GraphQLController';
import { AttachmentFileLoader } from './loaders/AttachmentFileLoader';
import { ConnectionLoader } from './loaders/ConnectionLoader';
import { ContentFileLoader } from './loaders/ContentFileLoader';
import { ContentLoader } from './loaders/ContentLoader';
import { EventContentsLoader } from './loaders/EventContentsLoader';
import { EventLoader } from './loaders/EventLoader';
import { EventMediaLoader } from './loaders/EventMediaLoader';
import { FileItemsLoader } from './loaders/FileItemsLoader';
import { ItemAcquisitionLoader, ReceiptLineItemsLoader } from './loaders/ItemAcquisitionLoader';
import { ItemFileLoader } from './loaders/ItemFileLoader';
import { ItemIdentifierLoader, ProductIdentifierLoader } from './loaders/ItemIdentifierLoader';
import { ItemObservationLoader } from './loaders/ItemObservationLoader';
import { ItemProductLoader } from './loaders/ItemProductLoader';
import { PersonIdentifiersLoader } from './loaders/PersonIdentifiersLoader';
import { PersonInteractionStatsLoader } from './loaders/PersonInteractionStatsLoader';
import { PersonLoader } from './loaders/PersonLoader';
import { PlaceLoader } from './loaders/PlaceLoader';
import { PlaceVisitStatsLoader } from './loaders/PlaceVisitStatsLoader';
import { PreviewLoader } from './loaders/PreviewLoader';
import { ProviderKeyLoader } from './loaders/ProviderKeyLoader';
import { ProviderLoader } from './loaders/ProviderLoader';
import { QuestionLoader } from './loaders/QuestionLoader';
import { TagAssignmentCountLoader } from './loaders/TagAssignmentCountLoader';
import { TagLoader } from './loaders/TagLoader';
import { ThreadLoader } from './loaders/ThreadLoader';
import { ThreadMessagesLoader } from './loaders/ThreadMessagesLoader';
import { UnfurlLoader } from './loaders/UnfurlLoader';
import { ComplexityPlugin } from './plugins/ComplexityPlugin';
import { ActionResolver } from './resolvers/ActionResolver';
import { ActivityResolver } from './resolvers/ActivityResolver';
import { AnswerResolver } from './resolvers/AnswerResolver';
import { AskResolver } from './resolvers/AskResolver';
import { BranchialResolver } from './resolvers/BranchialResolver';
import { BrowserActivityResolver } from './resolvers/BrowserActivityResolver';
import { CommunicationResolver } from './resolvers/CommunicationResolver';
import { ConceptResolver } from './resolvers/ConceptResolver';
import { ConnectionResolver } from './resolvers/ConnectionResolver';
import { ConnectionSyncJobResolver } from './resolvers/ConnectionSyncJobResolver';
import { ContentResolver } from './resolvers/ContentResolver';
import { DailyMetricsResolver } from './resolvers/DailyMetricsResolver';
import { EventResolver } from './resolvers/EventResolver';
import { FileResolver } from './resolvers/FileResolver';
import { ForageResolver } from './resolvers/ForageResolver';
import { ForecastResolver } from './resolvers/ForecastResolver';
import { GeocodeResolver } from './resolvers/GeocodeResolver';
import { GraphIngestResolver } from './resolvers/GraphIngestResolver';
import { GraphResolver } from './resolvers/GraphResolver';
import { ItemRelationshipResolver } from './resolvers/ItemRelationshipResolver';
import { ItemResolver } from './resolvers/ItemResolver';
import { KnownPlacesResolver } from './resolvers/KnownPlacesResolver';
import { NodeResolver } from './resolvers/NodeResolver';
import { NoteResolver } from './resolvers/NoteResolver';
import { ObjectObservationResolver } from './resolvers/ObjectObservationResolver';
import { PeerLinkResolver } from './resolvers/PeerLinkResolver';
import { PersonResolver } from './resolvers/PersonResolver';
import { PlaceResolver } from './resolvers/PlaceResolver';
import { PositionResolver } from './resolvers/PositionResolver';
import { ProductModelResolver } from './resolvers/ProductModelResolver';
import { ProviderKeyResolver } from './resolvers/ProviderKeyResolver';
import { ProviderResolver } from './resolvers/ProviderResolver';
import { QuestionResolver } from './resolvers/QuestionResolver';
import { ReceiptResolver } from './resolvers/ReceiptResolver';
import { RelationshipResolver } from './resolvers/RelationshipResolver';
import { SavedSearchResolver } from './resolvers/SavedSearchResolver';
import { ScheduleCandidateResolver } from './resolvers/ScheduleCandidateResolver';
import { SearchResolver } from './resolvers/SearchResolver';
import { SourceSystemResolver } from './resolvers/SourceSystemResolver';
import { SummaryResolver } from './resolvers/SummaryResolver';
import { TagResolver } from './resolvers/TagResolver';
import { TaskResolver } from './resolvers/TaskResolver';
import { ThreadResolver } from './resolvers/ThreadResolver';
import { UserResolver } from './resolvers/UserResolver';

@Module({
  imports: [
    // Entities owned by the memory domain, registered here so the object-identity
    // DataLoaders can batch-read them. Their services expose no batched read on
    // these keys (`ObjectObservationService.find` has no resolvedObjectId
    // predicate; `ReceiptService.findLines` reads one receipt at a time), and the
    // only alternative is a query per row — the N+1 a loader exists to prevent.
    // Both reads scope on `user_id` exactly as the services do.
    TypeOrmModule.forFeature([ObjectObservationEntity, ReceiptLineItemEntity]),
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
    AsksModule,
    AgentModule,
    PeersModule,
    ActivityModule,
    BrowserActivityModule,
    ConnectionsModule,
    DeviceModule,
    PrivacyModule,
    PredictionsModule,
    PythonFunctionsModule,
    ConversationModule,
    DailyMetricsModule,
    EntityResolutionModule,
    EtlModule,
    FilesModule,
    GeocodeModule,
    EmbedModule,
    GraphModule,
    IntelligenceModule,
    MemoryModule,
    NotesModule,
    ParsingModule,
    PlanningModule,
    PositionModule,
    SearchNextModule,
    ScheduleModule,
    SummariesModule,
    UserModule,
  ],
  providers: [
    ActionResolver,
    ActivityResolver,
    AskResolver,
    BranchialResolver,
    ForageResolver,
    ForecastResolver,
    GeocodeResolver,
    ScheduleCandidateResolver,
    BrowserActivityResolver,
    CommunicationResolver,
    ComplexityPlugin,
    ConceptResolver,
    ConnectionLoader,
    ConnectionResolver,
    ConnectionSyncJobResolver,
    ContentFileLoader,
    ContentLoader,
    ContentResolver,
    DailyMetricsResolver,
    NodeResolver,
    NoteResolver,
    TaskResolver,
    AnswerResolver,
    AttachmentFileLoader,
    EventContentsLoader,
    EventLoader,
    EventMediaLoader,
    EventResolver,
    FileItemsLoader,
    FileResolver,
    GraphIngestResolver,
    GraphResolver,
    ItemAcquisitionLoader,
    ItemFileLoader,
    ItemIdentifierLoader,
    ItemObservationLoader,
    ItemProductLoader,
    ItemRelationshipResolver,
    ItemResolver,
    KnownPlacesResolver,
    ObjectObservationResolver,
    PersonIdentifiersLoader,
    PersonInteractionStatsLoader,
    PersonLoader,
    PeerLinkResolver,
    PersonResolver,
    PlaceLoader,
    PlaceVisitStatsLoader,
    PlaceResolver,
    PositionResolver,
    PreviewLoader,
    ProductIdentifierLoader,
    ProductModelResolver,
    ProviderResolver,
    ProviderKeyLoader,
    ProviderKeyResolver,
    ProviderLoader,
    QuestionLoader,
    QuestionResolver,
    ReceiptLineItemsLoader,
    ReceiptResolver,
    RelationshipResolver,
    SavedSearchResolver,
    SearchResolver,
    SourceSystemResolver,
    SummaryResolver,
    TagAssignmentCountLoader,
    TagLoader,
    UnfurlLoader,
    TagResolver,
    ThreadLoader,
    ThreadMessagesLoader,
    ThreadResolver,
    UserResolver,
  ],
  controllers: [GraphQLController],
  exports: [NestGraphQLModule],
})
export class GraphQLModule {}
