import { redirect } from 'next/navigation';
import { UserDetailsPanel } from '@/components/dashboard/user-details-panel';
import { Alert } from '@/components/ui/alert';
import { getCurrentSession } from '@/lib/api-server';
import { impersonationAppUrls } from '@/lib/app-urls';
import { getServerT } from '@/lib/i18n-server';

export default async function UserPage({ params }: PageProps<'/users/[id]'>) {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (session.user.role !== 'SUPER_ADMIN') {
    const { t } = await getServerT();
    return <Alert variant="destructive">{t('errors.FORBIDDEN')}</Alert>;
  }
  const { id } = await params;
  return (
    <UserDetailsPanel id={id} currentUserId={session.user.id} appUrls={impersonationAppUrls()} />
  );
}
