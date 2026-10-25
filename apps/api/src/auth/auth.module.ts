import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthTokenService } from './auth-token.service.js';
import { AuthGuard } from './auth.guard.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthTokenService, PasswordService, SessionService, AuthGuard],
  exports: [AuthTokenService, PasswordService, SessionService, AuthGuard],
})
export class AuthModule {}
