import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { canManageShipments } from '@coobra/shared';
import { ShipmentsPanel } from '@/components/shipments/shipments-panel';
import { getCurrentSession } from '@/lib/api-server';

export default async function ShipmentsPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  return (
    <Suspense>
      <ShipmentsPanel canManage={canManageShipments(session.user.role)} />
    </Suspense>
  );
}
