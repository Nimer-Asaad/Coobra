import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/login-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentSession } from '@/lib/api-server';
import { getServerT } from '@/lib/i18n-server';

export default async function LoginPage() {
  if (await getCurrentSession()) redirect('/dashboard');
  const { t } = await getServerT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.login.title')}</CardTitle>
        <CardDescription>{t('auth.login.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm />
      </CardContent>
    </Card>
  );
}
