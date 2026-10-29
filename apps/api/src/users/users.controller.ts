import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  changeUserRoleSchema,
  changeUserStatusSchema,
  createUserSchema,
  listUsersQuerySchema,
  updatePreferencesSchema,
  updateUserProfileSchema,
  type AuthUser,
  type ChangeUserRoleInput,
  type ChangeUserStatusInput,
  type CreateUserInput,
  type ListUsersQuery,
  type Paginated,
  type UpdatePreferencesInput,
  type UpdateUserProfileInput,
  type UserDetails,
  type UserListItem,
} from '@coobra/shared';
import { AllowUnverifiedEmail, Auth, Meta, Roles } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { toAuthUser, toUserListItem } from './user.mapper.js';
import { UserAdminService } from './user-admin.service.js';
import { UsersService } from './users.service.js';

@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly admin: UserAdminService,
  ) {}

  @AllowUnverifiedEmail()
  @Patch('me/preferences')
  async updatePreferences(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(updatePreferencesSchema)) body: UpdatePreferencesInput,
    @Meta() meta: RequestMeta,
  ): Promise<AuthUser> {
    return toAuthUser(await this.users.updateLanguage(auth.user, body.language, meta));
  }

  // ---------------------------------------------------------------------------
  // User management (SUPER_ADMIN only; the service checks again)
  // ---------------------------------------------------------------------------

  @Roles('SUPER_ADMIN')
  @Get('admin/users')
  list(
    @Auth() auth: RequestAuth,
    @Query(new ZodValidationPipe(listUsersQuerySchema)) query: ListUsersQuery,
  ): Promise<Paginated<UserListItem>> {
    return this.admin.list(auth.user, query);
  }

  @Roles('SUPER_ADMIN')
  @Post('admin/users')
  async create(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput,
    @Meta() meta: RequestMeta,
  ): Promise<UserListItem> {
    const user = await this.users.createInvitedUser(body, auth.user.id, meta);
    return toUserListItem({ ...user, merchantProfile: null });
  }

  @Roles('SUPER_ADMIN')
  @Get('admin/users/:id')
  details(@Auth() auth: RequestAuth, @Param('id') id: string): Promise<UserDetails> {
    return this.admin.details(auth.user, id);
  }

  @Roles('SUPER_ADMIN')
  @Patch('admin/users/:id')
  updateProfile(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserProfileSchema)) body: UpdateUserProfileInput,
    @Meta() meta: RequestMeta,
  ): Promise<UserDetails> {
    return this.admin.updateProfile(auth.user, id, body, meta);
  }

  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  @Post('admin/users/:id/deactivate')
  deactivate(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeUserStatusSchema)) body: ChangeUserStatusInput,
    @Meta() meta: RequestMeta,
  ): Promise<UserDetails> {
    return this.admin.setActive(auth.user, id, false, body, meta);
  }

  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  @Post('admin/users/:id/reactivate')
  reactivate(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeUserStatusSchema)) body: ChangeUserStatusInput,
    @Meta() meta: RequestMeta,
  ): Promise<UserDetails> {
    return this.admin.setActive(auth.user, id, true, body, meta);
  }

  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  @Post('admin/users/:id/role')
  changeRole(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeUserRoleSchema)) body: ChangeUserRoleInput,
    @Meta() meta: RequestMeta,
  ): Promise<UserDetails> {
    return this.admin.changeRole(auth.user, id, body, meta);
  }
}
