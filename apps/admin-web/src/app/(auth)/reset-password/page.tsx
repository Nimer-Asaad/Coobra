import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerT } from '@/lib/i18n-server';

export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  const { token } = await searchParams;
  const { t } = await getServerT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.reset.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResetPasswordForm token={typeof token === 'string' ? token : undefined} />
      </CardContent>
    </Card>
  );
}
