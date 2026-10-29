import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UserAdminService } from './user-admin.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, UserAdminService],
})
export class UsersModule {}
