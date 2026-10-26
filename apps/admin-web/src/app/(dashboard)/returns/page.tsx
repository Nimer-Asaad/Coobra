import { redirect } from 'next/navigation';
import {
  canManageShipments,
  FINANCE_ROLES,
  SHIPMENT_VIEWER_ROLES,
  type UserRole,
} from '@coobra/shared';
import { ReturnsPanel } from '@/components/returns/returns-panel';
import { Alert } from '@/components/ui/alert';
import { getCurrentSession } from '@/lib/api-server';
import { getServerT } from '@/lib/i18n-server';

export default async function ReturnsPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const { role } = session.user;
  if (!(SHIPMENT_VIEWER_ROLES as readonly UserRole[]).includes(role)) {
    const { t } = await getServerT();
    return <Alert variant="destructive">{t('errors.FORBIDDEN')}</Alert>;
  }
  return (
    <ReturnsPanel
      canApprove={canManageShipments(role)}
      canDecideFee={(FINANCE_ROLES as readonly UserRole[]).includes(role)}
    />
  );
}
