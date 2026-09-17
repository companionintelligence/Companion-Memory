import type { OnboardingProgress } from './entities/UserEntity';

export interface CreateUserDto {
  id?: string;
  name: string;
  email: string;
  password: string;
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
  onboardingProgress?: OnboardingProgress | null;
}
