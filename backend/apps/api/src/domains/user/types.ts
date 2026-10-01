import type { OnboardingProgress, TimeFormat } from './entities/UserEntity';

export interface CreateUserDto {
  id?: string;
  name: string;
  email: string;
  password: string;
  /**
   * `false` when `password` is a random value the user will never see — the
   * Portal, OIDC and Hub-bridge provisioning paths — so `passwordSetAt` stays
   * null and account changes cannot demand it. Default: the user chose it.
   */
  passwordChosenByUser?: boolean;
  /**
   * IANA zone name. Omitted, the column default ('UTC') stands and
   * {@link ClientTimezoneInterceptor} adopts the first client zone it sees —
   * which is what every interactive signup path wants. Set it only where no
   * browser will ever reach the account, i.e. the seeder and `create-test-user`.
   */
  timezone?: string;
}

export interface UpdateUserDto {
  id?: string;
  name?: string;
  email?: string;
  password?: string;
  onboarded?: boolean;
  entityId?: string;
  timezone?: string;
  timeFormat?: TimeFormat;
  onboardingProgress?: OnboardingProgress | null;
}
