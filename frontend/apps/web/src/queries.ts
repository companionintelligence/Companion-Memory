import { gql } from '@apollo/client';

/** What GET_OAUTH_CALLBACK_URL reads. */
export interface OAuthCallbackUrlQueryData {
  oAuthCallbackUrl: string;
}

/** What GET_PROVIDERS reads, typed as the schema types the fields. */
export interface ProvidersQueryData {
  providers: {
    edges: Array<{
      node: {
        id: string;
        name: string | null;
        description: string | null;
        logoUrl: string | null;
        localOnly: boolean;
        appSetupUrl: string | null;
        authType: string | null;
        scopes: string[] | null;
        providerKeys: {
          id: string;
          clientId: string;
          hasClientSecret: boolean;
          clientSecretHint: string | null;
        } | null;
      };
    }>;
  };
}

export const GET_OAUTH_CALLBACK_URL = gql`
  query GetOAuthCallbackUrl {
    oAuthCallbackUrl
  }
`;

export const GET_PROVIDERS = gql`
  query GetProviders {
    providers {
      edges {
        cursor
        node {
          id
          name
          description
          logoUrl
          localOnly
          appSetupUrl
          authType
          scopes
          providerKeys {
            id
            clientId
            hasClientSecret
            clientSecretHint
          }
        }
      }
    }
  }
`;
