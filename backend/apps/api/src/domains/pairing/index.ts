import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import config from '@ci/configuration';

import { PairingController } from './controllers/PairingController';
import { PairingEntity } from './entities/PairingEntity';
import { PairingService } from './services/PairingService';

@Module({
  imports: [
    TypeOrmModule.forFeature([PairingEntity]),
    JwtModule.register({
      secret: config.auth.jwt.authTokenSecret,
      signOptions: { expiresIn: config.auth.jwt.authTokenExpiration },
    }),
  ],
  providers: [PairingService],
  controllers: [PairingController],
  exports: [PairingService],
})
export class PairingModule {}

export { PairingService };
