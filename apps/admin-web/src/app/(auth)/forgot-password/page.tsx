import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerT } from '@/lib/i18n-server';

export default async function ForgotPasswordPage() {
  const { t } = await getServerT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.forgot.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ForgotPasswordForm />
      </CardContent>
    </Card>
  );
}
