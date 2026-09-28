import { Controller, Get, Header, NotFoundException } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';

import { GRAPHIQL_HTML } from './graphiql.html';

@Controller()
export class GraphQLController {
  constructor(private readonly features: FeatureService) {}

  /**
   * Serves the GraphiQL IDE. Reachable from the browser at `/api/graphiql`
   * (the reverse proxy strips the `/api` prefix). Kept off `/graphql` so it
   * never collides with the Apollo driver mounted there for GraphQL requests.
   *
   * Gated by the `graphql.ide` flag rather than an auth guard: the page
   * authenticates per request with a pasted API key, so a guard on the HTML
   * would break the "open in a new tab" it exists for. Off in production by
   * default (`config/production.json`); a 404 there, like every other
   * flag-dark route.
   */
  @Get('graphiql')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async graphiql(): Promise<string> {
    if (!(await this.features.isFeatureEnabled('graphql.ide'))) {
      throw new NotFoundException();
    }

    return GRAPHIQL_HTML;
  }
}
