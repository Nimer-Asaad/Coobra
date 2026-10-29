import { z } from 'zod';
import type { Language } from './language.js';
import { STAFF_ROLES, USER_ROLES, type UserRole } from './roles.js';
import { reasonSchema } from './shipments.js';
import { languageSchema, nameSchema, phoneSchema } from './validation.js';
import type { UserStatus } from './api-types.js';

/*
 * Phase 4A administrative user management. SUPER_ADMIN only (routes and services).
 *
 * - Profile edits: full name, phone, language and (merchants) business name. The email is the
 *   sign-in identity and is not edited here.
 * - Role changes only between staff roles. DRIVER and MERCHANT accounts own ledger accounts
 *   (cash custody, receivables, balances), so their role never changes.
 * - Deactivation and role changes revoke every session of the user immediately.
 * - Nobody deactivates or changes the role of their own account, and the last active
 *   SUPER_ADMIN can never be deactivated or demoted.
 * - Every change carries the `updatedAt` the administrator saw; a newer row is a 409 conflict.
 */

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const satisfies readonly UserStatus[];
export const USER_PAGE_SIZE_MAX = 100;

/** Roles a SUPER_ADMIN may switch an account between. */
export const ROLE_CHANGEABLE_ROLES = STAFF_ROLES;

export function isRoleChangeable(role: UserRole): boolean {
  return (ROLE_CHANGEABLE_ROLES as readonly UserRole[]).includes(role);
}

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

export const listUsersQuerySchema = z.object({
  /** Name, email, phone or business name. */
  q: optionalText.pipe(z.string().max(100).optional()),
  role: z.enum(USER_ROLES, { error: 'validation.role.invalid' }).optional(),
  status: z.enum(USER_STATUSES, { error: 'validation.status.invalid' }).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(USER_PAGE_SIZE_MAX).default(20),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** The row version the administrator saw (the user's `updatedAt`). */
const expectedUpdatedAt = z.iso.datetime({
  offset: true,
  error: 'validation.user.version',
});

export const updateUserProfileSchema = z
  .object({
    fullName: nameSchema.optional(),
    /** Empty string or null clears the phone. */
    phone: z.union([z.literal(''), z.null(), phoneSchema]).optional(),
    language: languageSchema.optional(),
    /** Merchants only. */
    businessName: nameSchema.optional(),
    expectedUpdatedAt,
  })
  .refine(
    (input) =>
      input.fullName !== undefined ||
      input.phone !== undefined ||
      input.language !== undefined ||
      input.businessName !== undefined,
    { message: 'validation.user.nothingToChange', path: ['fullName'] },
  );
export type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;

export const changeUserStatusSchema = z.object({
  reason: reasonSchema,
  expectedUpdatedAt,
});
export type ChangeUserStatusInput = z.infer<typeof changeUserStatusSchema>;

export const changeUserRoleSchema = z.object({
  role: z.enum(ROLE_CHANGEABLE_ROLES, { error: 'validation.role.invalid' }),
  reason: reasonSchema,
  expectedUpdatedAt,
});
export type ChangeUserRoleInput = z.infer<typeof changeUserRoleSchema>;

export interface UserAuditEntry {
  id: string;
  action: string;
  actor: { id: string; fullName: string } | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface UserDetails {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  language: Language;
  emailVerified: boolean;
  merchant: { businessName: string } | null;
  createdAt: string;
  /** The row version to send back with any change. */
  updatedAt: string;
  createdBy: { id: string; fullName: string } | null;
  lastSignInAt: string | null;
  activeSessions: number;
  /** Changes made to this account (newest first). */
  history: UserAuditEntry[];
}
