import type { Request } from 'express';
import type { Session } from '@coobra/database';
import type { UserWithProfile } from '../users/user.mapper.js';
import type { ActingContext } from './acting-context.js';

export interface RequestAuth {
  /** The account the session belongs to (the principal; see `acting`). */
  user: UserWithProfile;
  session: Session;
  /** How the session token reached the API. */
  transport: 'bearer' | 'cookie';
  /** Real actor, effective principal and impersonation (ADR 0003 §2). */
  acting: ActingContext;
}

export interface AppRequest extends Request {
  auth?: RequestAuth;
}

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export function requestMeta(request: Request): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, 512) : null,
  };
}

/** Reads a single cookie from the raw Cookie header (avoids a cookie-parser dependency). */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
