import type { MerchantProfile, User } from '@coobra/database';
// User rows always go through these mappers: the password hash never leaves the API.
import type { AuthUser, UserListItem } from '@coobra/shared';

export type UserWithProfile = User & { merchantProfile: MerchantProfile | null };

/** Maps a database user to the public API shape. Never exposes the password hash. */
export function toAuthUser(user: UserWithProfile): AuthUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
    language: user.language,
    merchant: user.merchantProfile
      ? {
          businessName: user.merchantProfile.businessName,
          pickupZoneId: user.merchantProfile.defaultPickupZoneId,
        }
      : null,
  };
}

export function toUserListItem(user: UserWithProfile): UserListItem {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
    businessName: user.merchantProfile?.businessName ?? null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
