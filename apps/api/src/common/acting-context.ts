import { AsyncLocalStorage } from 'node:async_hooks';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { UserRole } from '@coobra/shared';
import type { AppRequest } from './request.js';

/*
 * Who is acting on a request (ADR 0003 §2, Phase 4C.2).
 *
 * - `actor`: the real human. Every "done by" column, the audit actor and every maker-checker
 *   comparison use it.
 * - `principal`: the account whose authority is used. Roles, data scoping and business rules
 *   use it.
 * - `impersonation`: set only while a SUPER_ADMIN operates another account.
 *
 * Outside impersonation the actor and the principal are the same person, so code that uses the
 * right one behaves exactly as before. Impersonation cannot start yet: sessions created by an
 * impersonation are refused (SessionService), so `impersonation` is always null in Phase 4C.2.
 */

export interface Person {
  id: string;
  role: UserRole;
}

export interface ImpersonationScope {
  id: string;
  /** The admin session the impersonation was started from. */
  actorSessionId: string;
  expiresAt: Date;
}

export interface ActingContext {
  actor: Person;
  principal: Person;
  impersonation: ImpersonationScope | null;
}

/** A person acting as themselves (every request today). */
export function selfActing(user: Person): ActingContext {
  const person = { id: user.id, role: user.role };
  return { actor: person, principal: person, impersonation: null };
}

const storage = new AsyncLocalStorage<ActingContext>();

/** The acting context of the current request, or null outside a request (CLI, startup). */
export function currentActingContext(): ActingContext | null {
  return storage.getStore() ?? null;
}

/** Runs `work` with `context` as the current acting context (requests and tests). */
export function runActing<T>(context: ActingContext, work: () => T): T {
  return storage.run(context, work);
}

/**
 * Makes the request's acting context available to every layer below the controller (audit,
 * ledger), so they can enforce impersonation rules even if a service forgets to pass it.
 * Runs after the global AuthGuard, which sets `request.auth`.
 */
@Injectable()
export class ActingContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const acting = context.switchToHttp().getRequest<AppRequest>().auth?.acting;
    if (!acting) return next.handle();
    // Subscribe inside the store so the handler and everything it awaits see the context.
    return new Observable((subscriber) =>
      runActing(acting, () => next.handle().subscribe(subscriber)),
    );
  }
}
