import { redirect } from 'next/navigation';
import { FINANCE_VIEW_ROLES, type UserRole } from '@coobra/shared';
import { FinancePanel } from '@/components/finance/finance-panel';
import { Alert } from '@/components/ui/alert';
import { getCurrentSession } from '@/lib/api-server';
import { getServerT } from '@/lib/i18n-server';

/**
 * Finance roles see everything; OPERATIONS register driver cash hand-overs and propose shortfall
 * resolutions. The API enforces it.
 */
export default async function FinancePage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const { role } = session.user;
  if (!(FINANCE_VIEW_ROLES as readonly UserRole[]).includes(role) && role !== 'OPERATIONS') {
    const { t } = await getServerT();
    return <Alert variant="destructive">{t('errors.FORBIDDEN')}</Alert>;
  }
  return <FinancePanel role={role} userId={session.user.id} />;
}
