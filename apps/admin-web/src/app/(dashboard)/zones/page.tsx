import { redirect } from 'next/navigation';
import { SHIPMENT_VIEWER_ROLES, ZONE_MANAGER_ROLES, type UserRole } from '@coobra/shared';
import { ZonesPanel } from '@/components/zones/zones-panel';
import { Alert } from '@/components/ui/alert';
import { getCurrentSession } from '@/lib/api-server';
import { getServerT } from '@/lib/i18n-server';

export default async function ZonesPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const { role } = session.user;
  if (!(SHIPMENT_VIEWER_ROLES as readonly UserRole[]).includes(role)) {
    const { t } = await getServerT();
    return <Alert variant="destructive">{t('errors.FORBIDDEN')}</Alert>;
  }
  return <ZonesPanel canManage={(ZONE_MANAGER_ROLES as readonly UserRole[]).includes(role)} />;
}
