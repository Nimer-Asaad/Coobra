import { redirect } from 'next/navigation';
import { canManageShipments } from '@coobra/shared';
import { ShipmentDetailsPanel } from '@/components/shipments/shipment-details-panel';
import { getCurrentSession } from '@/lib/api-server';

export default async function ShipmentPage({ params }: PageProps<'/shipments/[id]'>) {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const { id } = await params;
  return (
    <ShipmentDetailsPanel
      id={id}
      canManage={canManageShipments(session.user.role)}
      role={session.user.role}
    />
  );
}
