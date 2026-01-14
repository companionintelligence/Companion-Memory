import path from 'node:path';

import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';

import { BrowserActivityModule } from '@ci/domains/browser-activity';
import { ConnectionsModule } from '@ci/domains/connections';
import { ConversationModule } from '@ci/domains/conversations';
import { FilesModule } from '@ci/domains/files';
import { IntelligenceModule } from '@ci/domains/intelligence';
import { MemoryModule } from '@ci/domains/memory';
import { NotesModule } from '@ci/domains/notes';
import { SearchNextModule } from '@ci/domains/search-next';
import { SummariesModule } from '@ci/domains/summaries';
import { UserModule } from '@ci/domains/user';

import { GraphQLController } from './controllers/GraphQLController';
import { EventLoader } from './loaders/EventLoader';
import { FileItemsLoader } from './loaders/FileItemsLoader';
import { ItemFileLoader } from './loaders/ItemFileLoader';
import { PersonLoader } from './loaders/PersonLoader';
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
import { ContentResolver } from './resolvers/ContentResolver';
import { EventResolver } from './resolvers/EventResolver';
import { FactResolver } from './resolvers/FactResolver';
import { FileResolver } from './resolvers/FileResolver';
import { ItemResolver } from './resolvers/ItemResolver';
import { NodeResolver } from './resolvers/NodeResolver';
import { NoteResolver } from './resolvers/NoteResolver';
import { PersonResolver } from './resolvers/PersonResolver';
import { PlaceResolver } from './resolvers/PlaceResolver';
import { ProviderResolver } from './resolvers/ProviderResolver';
import { QuestionResolver } from './resolvers/QuestionResolver';
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
    ConversationModule,
    FilesModule,
    IntelligenceModule,
    MemoryModule,
    NotesModule,
    SearchNextModule,
    SummariesModule,
    UserModule,
  ],
  providers: [
    ActionResolver,
    BrowserActivityResolver,
    CommunicationResolver,
    ComplexityPlugin,
    ConceptResolver,
    ContentResolver,
    NodeResolver,
    NoteResolver,
    AnswerResolver,
    EventLoader,
    EventResolver,
    FactResolver,
    FileItemsLoader,
    FileResolver,
    ItemFileLoader,
    ItemResolver,
    PersonLoader,
    PersonResolver,
    QuestionLoader,
    QuestionResolver,
    SavedSearchResolver,
    SearchResolver,
    SummaryResolver,
    TagLoader,
    TagResolver,
    ThreadLoader,
    ThreadMessagesLoader,
    ThreadResolver,
    UserResolver,
    PlaceResolver,
    ProviderResolver,
  ],
  controllers: [GraphQLController],
  exports: [],
})
export class GraphQLModule {}
