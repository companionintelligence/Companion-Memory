import type { Params } from '@feathersjs/feathers';

import { Application } from '../configuration/types';

import type { UserType } from './user-service';

export class SignupService {
  app: Application;

  constructor(app: Application) {
    this.app = app;
  }

  async create(data: UserType, params: Params) {
    const userService = this.app.service('users');

    // Pass through internal params to bypass external hooks if needed
    const createdUser = await userService.create(data, {
      ...params,
      provider: undefined, // mark as internal call
    });

    // Omit password
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, ...rest } = createdUser;

    // Authenticate
    const authResult = await this.app.service('authenticate').create({
      strategy: 'local',
      email: data.email,
      password: data.password
    }, {
      provider: undefined
    });

    rest.accessToken = authResult.accessToken

    return rest;
  }
}
