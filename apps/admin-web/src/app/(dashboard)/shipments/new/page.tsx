import { redirect } from 'next/navigation';
import { canManageShipments } from '@coobra/shared';
import { CreateShipmentForm } from '@/components/shipments/create-shipment-form';
import { Alert } from '@/components/ui/alert';
import { getCurrentSession } from '@/lib/api-server';
import { getServerT } from '@/lib/i18n-server';

/** Only SUPER_ADMIN and OPERATIONS create shipments (the API enforces the same rule). */
export default async function NewShipmentPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!canManageShipments(session.user.role)) {
    const { t } = await getServerT();
    return <Alert variant="destructive">{t('errors.FORBIDDEN')}</Alert>;
  }
  return <CreateShipmentForm />;
}
