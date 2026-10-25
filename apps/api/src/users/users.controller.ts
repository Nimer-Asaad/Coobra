import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import {
  createUserSchema,
  updatePreferencesSchema,
  type AuthUser,
  type CreateUserInput,
  type UpdatePreferencesInput,
  type UserListItem,
} from '@coobra/shared';
import { AllowUnverifiedEmail, Auth, Meta, Roles } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { toAuthUser, toUserListItem } from './user.mapper.js';
import { UsersService } from './users.service.js';

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @AllowUnverifiedEmail()
  @Patch('me/preferences')
  async updatePreferences(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(updatePreferencesSchema)) body: UpdatePreferencesInput,
    @Meta() meta: RequestMeta,
  ): Promise<AuthUser> {
    return toAuthUser(await this.users.updateLanguage(auth.user, body.language, meta));
  }

  @Roles('SUPER_ADMIN')
  @Get('admin/users')
  async list(): Promise<{ items: UserListItem[] }> {
    return { items: (await this.users.list()).map(toUserListItem) };
  }

  @Roles('SUPER_ADMIN')
  @Post('admin/users')
  async create(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput,
    @Meta() meta: RequestMeta,
  ): Promise<UserListItem> {
    return toUserListItem(await this.users.createInvitedUser(body, auth.user.id, meta));
  }
}
