import path from 'node:path';

import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule as NestGraphQLModule } from '@nestjs/graphql';

import { ConversationModule } from '@ci/domains/conversations';
import { FilesModule } from '@ci/domains/files';
import { MemoryModule } from '@ci/domains/memory';
import { SearchNextModule } from '@ci/domains/search-next';
import { UserModule } from '@ci/domains/user';

import { GraphQLController } from './controllers/GraphQLController';
import { FileItemsLoader } from './loaders/FileItemsLoader';
import { ItemFileLoader } from './loaders/ItemFileLoader';
import { ThreadMessagesLoader } from './loaders/ThreadMessagesLoader';
import { ComplexityPlugin } from './plugins/ComplexityPlugin';
import { FactResolver } from './resolvers/FactResolver';
import { FileResolver } from './resolvers/FileResolver';
import { ItemResolver } from './resolvers/ItemResolver';
import { NodeResolver } from './resolvers/NodeResolver';
import { PersonResolver } from './resolvers/PersonResolver';
import { SearchResolver } from './resolvers/SearchResolver';
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
    ConversationModule,
    FilesModule,
    MemoryModule,
    SearchNextModule,
    UserModule,
  ],
  providers: [
    ComplexityPlugin,
    NodeResolver,
    FactResolver,
    FileItemsLoader,
    FileResolver,
    ItemFileLoader,
    ItemResolver,
    PersonResolver,
    SearchResolver,
    TagResolver,
    ThreadMessagesLoader,
    ThreadResolver,
    UserResolver,
  ],
  controllers: [GraphQLController],
  exports: [],
})
export class GraphQLModule {}
