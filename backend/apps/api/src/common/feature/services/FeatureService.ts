import { Injectable } from '@nestjs/common';

import config from '@ci/configuration';

export type FeatureName = keyof typeof config.features;

/**
 * The flags an ANONYMOUS caller may read — exactly the ones the web needs
 * before anyone has signed in (`SignupForm` and `OnboardingPage`, via
 * `useFeatures`' global fetch).
 *
 * `GET /_internal/features/global` used to return the whole map, which is the
 * same answer the authenticated route gives: thirty-odd booleans naming what
 * this appliance runs. Nothing in it is a secret, but it is a map of the
 * surface for anyone who can reach the port, and only two entries were ever
 * read before login. Adding a pre-login flag means adding it here, on purpose.
 */
export const PUBLIC_FEATURES = [
  'require.signup.codes',
  'onboarding.preference.steps',
] as const satisfies readonly FeatureName[];

export type PublicFeatureName = (typeof PUBLIC_FEATURES)[number];

@Injectable()
export class FeatureService {
  private features = config.features;

  async isFeatureEnabled(name: FeatureName): Promise<boolean> {
    return this.features[name] === true;
  }

  async getAllFeatures(): Promise<typeof this.features> {
    return this.features;
  }

  /** The {@link PUBLIC_FEATURES} subset, for the unauthenticated route. */
  async getPublicFeatures(): Promise<Record<PublicFeatureName, boolean>> {
    return Object.fromEntries(PUBLIC_FEATURES.map((name) => [name, this.features[name] === true])) as Record<
      PublicFeatureName,
      boolean
    >;
  }
}
