import type { User } from '@ci/domains/user';

export interface ContactLog {
  readonly id: string;
  readonly content: Record<string, unknown>;
  readonly user?: User;
  readonly created_at: Date;
}

export interface LocationLog {
  readonly id: string;
  readonly content: Record<string, unknown>;
  readonly user?: User;
  readonly created_at: Date;
}

export interface CreateContactLogDto {
  content: Record<string, unknown>;
}

export interface CreateLocationLogDto {
  content: Record<string, unknown>;
}
