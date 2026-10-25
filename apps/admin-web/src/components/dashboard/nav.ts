import { FINANCE_VIEW_ROLES, SHIPMENT_VIEWER_ROLES, type UserRole } from '@coobra/shared';

export interface NavItem {
  href: string;
  labelKey: string;
  roles?: readonly UserRole[];
}

/** Navigation is filtered by role; the API enforces the same rules on every request. */
export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', labelKey: 'nav.dashboard' },
  { href: '/shipments', labelKey: 'nav.shipments', roles: SHIPMENT_VIEWER_ROLES },
  { href: '/returns', labelKey: 'nav.returns', roles: SHIPMENT_VIEWER_ROLES },
  { href: '/finance', labelKey: 'nav.finance', roles: [...FINANCE_VIEW_ROLES, 'OPERATIONS'] },
  { href: '/pricing', labelKey: 'nav.pricing', roles: SHIPMENT_VIEWER_ROLES },
  { href: '/zones', labelKey: 'nav.zones', roles: SHIPMENT_VIEWER_ROLES },
  { href: '/users', labelKey: 'nav.users', roles: ['SUPER_ADMIN'] },
  { href: '/settings', labelKey: 'nav.settings' },
];

export function navItemsFor(role: UserRole): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(role));
}
