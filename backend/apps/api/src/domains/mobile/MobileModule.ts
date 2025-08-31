import { Module } from '@nestjs/common';

import { AuthModule } from '@ci/domains/auth';
import { UserModule } from '@ci/domains/user';
import { FilesModule } from '@ci/domains/files';

import { MobileAuthController } from './controllers/MobileAuthController';
import { MobileUserController } from './controllers/MobileUserController';
import { MobileFilesController } from './controllers/MobileFilesController';

@Module({
  imports: [AuthModule, UserModule, FilesModule],
  controllers: [MobileAuthController, MobileUserController, MobileFilesController],
})
export class MobileModule {}