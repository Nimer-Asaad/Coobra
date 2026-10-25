export const USER_ROLES = [
  'SUPER_ADMIN',
  'ACCOUNTANT',
  'OWNER_VIEWER',
  'OPERATIONS',
  'DRIVER',
  'MERCHANT',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Roles that work inside the admin web application. */
export const STAFF_ROLES = [
  'SUPER_ADMIN',
  'ACCOUNTANT',
  'OWNER_VIEWER',
  'OPERATIONS',
] as const satisfies readonly UserRole[];

/** The client applications that can open a session. */
export const CLIENT_APPS = ['ADMIN_WEB', 'DRIVER_APP', 'MERCHANT_APP'] as const;
export type ClientApp = (typeof CLIENT_APPS)[number];

/** Which roles are allowed to sign in to which client application. */
export const CLIENT_APP_ROLES: Record<ClientApp, readonly UserRole[]> = {
  ADMIN_WEB: STAFF_ROLES,
  DRIVER_APP: ['DRIVER'],
  MERCHANT_APP: ['MERCHANT'],
};

/** Roles a SUPER_ADMIN may assign when creating accounts. Merchants self-register. */
export const ADMIN_ASSIGNABLE_ROLES = [
  'SUPER_ADMIN',
  'ACCOUNTANT',
  'OWNER_VIEWER',
  'OPERATIONS',
  'DRIVER',
] as const satisfies readonly UserRole[];
export type AdminAssignableRole = (typeof ADMIN_ASSIGNABLE_ROLES)[number];

export function isRoleAllowedForApp(role: UserRole, app: ClientApp): boolean {
  return CLIENT_APP_ROLES[app].includes(role);
}

/** The client application where a user of the given role signs in. */
export function clientAppForRole(role: UserRole): ClientApp {
  if (role === 'DRIVER') return 'DRIVER_APP';
  if (role === 'MERCHANT') return 'MERCHANT_APP';
  return 'ADMIN_WEB';
}
