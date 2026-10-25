import { redirect } from 'next/navigation';
import {
  canManageShipments,
  PRICING_MANAGER_ROLES,
  SHIPMENT_VIEWER_ROLES,
  type UserRole,
} from '@coobra/shared';
import { PricingPanel } from '@/components/pricing/pricing-panel';
import { Alert } from '@/components/ui/alert';
import { getCurrentSession } from '@/lib/api-server';
import { getServerT } from '@/lib/i18n-server';

export default async function PricingPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const { role } = session.user;
  if (!(SHIPMENT_VIEWER_ROLES as readonly UserRole[]).includes(role)) {
    const { t } = await getServerT();
    return <Alert variant="destructive">{t('errors.FORBIDDEN')}</Alert>;
  }
  return (
    <PricingPanel
      canManageRules={(PRICING_MANAGER_ROLES as readonly UserRole[]).includes(role)}
      canSetPickup={canManageShipments(role)}
    />
  );
}
