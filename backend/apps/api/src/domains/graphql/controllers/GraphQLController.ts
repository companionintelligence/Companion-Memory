import { Controller, Get, Header } from '@nestjs/common';

import { GRAPHIQL_HTML } from './graphiql.html';

@Controller()
export class GraphQLController {
  /**
   * Serves the GraphiQL IDE. Reachable from the browser at `/api/graphiql`
   * (the reverse proxy strips the `/api` prefix). Kept off `/graphql` so it
   * never collides with the Apollo driver mounted there for GraphQL requests.
   */
  @Get('graphiql')
  @Header('Content-Type', 'text/html; charset=utf-8')
  graphiql(): string {
    return GRAPHIQL_HTML;
  }
}
