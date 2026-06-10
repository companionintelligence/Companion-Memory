import { gql } from '@apollo/client';

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
            clientSecret
          }
        }
      }
    }
  }
`;
