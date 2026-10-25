import Link from 'next/link';
import { redirect } from 'next/navigation';
import { canManageShipments, SHIPMENT_VIEWER_ROLES, type UserRole } from '@coobra/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentSession } from '@/lib/api-server';
import { getServerT } from '@/lib/i18n-server';

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const { t } = await getServerT();
  const { user } = session;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('home.welcome', { name: user.fullName })}</CardTitle>
        <CardDescription>{t('home.phaseNotice')}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted-foreground">{t('home.roleLabel')}</dt>
            <dd className="font-medium">{t(`roles.${user.role}`)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">{t('home.emailLabel')}</dt>
            <dd className="font-medium">
              <span dir="ltr">{user.email}</span>
            </dd>
          </div>
        </dl>
        {(SHIPMENT_VIEWER_ROLES as readonly UserRole[]).includes(user.role) ? (
          <div className="mt-6 flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/shipments">{t('nav.shipments')}</Link>
            </Button>
            {canManageShipments(user.role) ? (
              <Button variant="outline" asChild>
                <Link href="/shipments/new">{t('nav.newShipment')}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
