import { redirect } from 'next/navigation';
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
      </CardContent>
    </Card>
  );
}
