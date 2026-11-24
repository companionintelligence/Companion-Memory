import { ApolloClient, ApolloLink, InMemoryCache } from '@apollo/client';

/**
 * The context `ApolloLink.execute` runs an operation in. The links under test never read
 * the client, so one that nothing is sent through is enough.
 */
export function executeContext(): ApolloLink.ExecuteContext {
  return { client: new ApolloClient({ cache: new InMemoryCache(), link: ApolloLink.empty() }) };
}
