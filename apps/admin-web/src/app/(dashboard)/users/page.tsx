import { redirect } from 'next/navigation';
import { UsersPanel } from '@/components/dashboard/users-panel';
import { Alert } from '@/components/ui/alert';
import { getCurrentSession } from '@/lib/api-server';
import { getServerT } from '@/lib/i18n-server';

export default async function UsersPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (session.user.role !== 'SUPER_ADMIN') {
    const { t } = await getServerT();
    return <Alert variant="destructive">{t('errors.FORBIDDEN')}</Alert>;
  }
  return <UsersPanel />;
}
