import path from 'node:path';

import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';

import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConnectionsModule } from '@ci/domains/connections';
import { ConversationModule } from '@ci/domains/conversations';
import { EtlModule } from '@ci/domains/etl';
import { FilesModule } from '@ci/domains/files';
import { GraphModule } from '@ci/domains/graph';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { PredictionsModule } from '@ci/domains/predictions';
import { SearchNextModule } from '@ci/domains/search-next';
import { SummariesModule } from '@ci/domains/summaries';
import { UserModule } from '@ci/domains/user';

import { GraphQLController } from './controllers/GraphQLController';
import { ConnectionLoader } from './loaders/ConnectionLoader';
import { EventLoader } from './loaders/EventLoader';
import { FileItemsLoader } from './loaders/FileItemsLoader';
import { ItemFileLoader } from './loaders/ItemFileLoader';
import { PersonLoader } from './loaders/PersonLoader';
import { PlaceLoader } from './loaders/PlaceLoader';
import { PreviewLoader } from './loaders/PreviewLoader';
import { ProviderKeyLoader } from './loaders/ProviderKeyLoader';
import { ProviderLoader } from './loaders/ProviderLoader';
import { QuestionLoader } from './loaders/QuestionLoader';
import { TagLoader } from './loaders/TagLoader';
import { ThreadLoader } from './loaders/ThreadLoader';
import { ThreadMessagesLoader } from './loaders/ThreadMessagesLoader';
import { ComplexityPlugin } from './plugins/ComplexityPlugin';
import { ActionResolver } from './resolvers/ActionResolver';
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
import { ItemResolver } from './resolvers/ItemResolver';
import { NodeResolver } from './resolvers/NodeResolver';
import { NoteResolver } from './resolvers/NoteResolver';
import { PersonResolver } from './resolvers/PersonResolver';
import { PlaceResolver } from './resolvers/PlaceResolver';
import { ProviderKeyResolver } from './resolvers/ProviderKeyResolver';
import { ProviderResolver } from './resolvers/ProviderResolver';
import { QuestionResolver } from './resolvers/QuestionResolver';
import { RelationshipResolver } from './resolvers/RelationshipResolver';
import { SavedSearchResolver } from './resolvers/SavedSearchResolver';
import { SearchResolver } from './resolvers/SearchResolver';
import { SummaryResolver } from './resolvers/SummaryResolver';
import { TagResolver } from './resolvers/TagResolver';
import { ThreadResolver } from './resolvers/ThreadResolver';
import { UserResolver } from './resolvers/UserResolver';

@Module({
  imports: [
    NestGraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: path.join(__dirname, '__generated__/schema.graphql'),
      sortSchema: true,
      playground: false,
      introspection: true,
      graphiql: false,
    }),
    BrowserActivityModule,
    ConnectionsModule,
    PredictionsModule,
    ConversationModule,
    EtlModule,
    FilesModule,
    GraphModule,
    IntelligenceModule,
    MemoryModule,
    NotesModule,
    SearchNextModule,
    SummariesModule,
    UserModule,
  ],
  providers: [
    ActionResolver,
    ForecastResolver,
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
    AnswerResolver,
    EventLoader,
    EventResolver,
    FileItemsLoader,
    FileResolver,
    ItemFileLoader,
    ItemResolver,
    PersonLoader,
    PersonResolver,
    PlaceLoader,
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
    UserResolver,
  ],
  controllers: [GraphQLController],
  exports: [NestGraphQLModule],
})
export class GraphQLModule {}
