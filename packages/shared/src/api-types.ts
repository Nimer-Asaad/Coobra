import type { Language } from './language.js';
import type { ClientApp, UserRole } from './roles.js';

export type UserStatus = 'ACTIVE' | 'DISABLED';

/** The authenticated user as returned by the API. Never contains secrets. */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  language: Language;
  merchant: { businessName: string } | null;
}

export interface SessionInfo {
  id: string;
  clientApp: ClientApp;
  expiresAt: string;
}

export interface LoginResponse {
  user: AuthUser;
  session: SessionInfo;
  /**
   * Opaque session token for Bearer authentication. Omitted when the client
   * requested cookie transport (the token is then set as an httpOnly cookie).
   */
  token?: string;
}

export interface MeResponse {
  user: AuthUser;
  session: SessionInfo;
}

export interface MessageResponse {
  ok: true;
}

export interface UserListItem {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  createdAt: string;
}

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
}

export interface ReadinessResponse {
  status: 'ok' | 'error';
  database: 'up' | 'down';
}

/** HTTP header a browser client sends to receive the session as an httpOnly cookie. */
export const AUTH_TRANSPORT_HEADER = 'x-auth-transport';
export const SESSION_COOKIE_NAME = 'coobra_session';
