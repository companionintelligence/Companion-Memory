export interface CreateUserDto {
  id?: string;
  name: string;
  email: string;
  password: string;
}

export interface UpdateUserDto {
  id?: string;
  name?: string;
  email?: string;
  password?: string;
  onboarded?: boolean;
  entityId?: string;
}
