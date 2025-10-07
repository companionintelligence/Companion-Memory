export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly onboarded: boolean;
}

export interface CreateUserDto {
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
}

export interface SignupCode {
  readonly id: string;
  readonly signup_code: string;
  readonly used: boolean;
}

export interface SignupDto {
  name: string;
  email: string;
  password: string;
  signup_code: string;
}

export interface UpdateSignupCodeDto {
  used?: boolean;
}
