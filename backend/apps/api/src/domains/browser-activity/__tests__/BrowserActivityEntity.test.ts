import { UserEntity } from '@ci/domains/user';

import { BrowserActivityEntity } from '../entities/BrowserActivityEntity';

describe('BrowserActivityEntity.toEgressType', () => {
  // The `user` relation is the raw account row, password hash included. It went
  // out as is, so a browser-visit search hit handed the hash to the model.
  it('passes the account through the user egress, without the password hash', () => {
    const user = Object.assign(new UserEntity(), {
      id: '00000000-0000-0000-0000-0000000000aa',
      name: 'Pb Tester',
      email: 'tester@example.com',
      password: '$2b$10$not-a-real-hash',
    });
    const visit = Object.assign(new BrowserActivityEntity(), {
      id: 'b1',
      time: new Date('2026-10-26T09:00:00Z'),
      user_id: user.id,
      url: 'https://bluebottlecoffee.com/menu',
      user,
    });

    const egress = BrowserActivityEntity.toEgressType(visit);

    expect(egress.user).toEqual(UserEntity.toEgressType(user));
    expect(JSON.stringify(egress)).not.toContain('not-a-real-hash');
    expect(egress).toMatchObject({ id: 'b1', url: 'https://bluebottlecoffee.com/menu', user_id: user.id });
  });

  it('leaves `user` out when the relation was not loaded', () => {
    const visit = Object.assign(new BrowserActivityEntity(), {
      id: 'b2',
      url: 'search:coffee',
      user_id: 'u',
    });

    expect(BrowserActivityEntity.toEgressType(visit).user).toBeUndefined();
  });
});
