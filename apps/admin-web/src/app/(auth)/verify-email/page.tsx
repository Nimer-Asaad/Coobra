import { VerifyEmail } from '@/components/auth/verify-email';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerT } from '@/lib/i18n-server';

export default async function VerifyEmailPage({ searchParams }: PageProps<'/verify-email'>) {
  const { token } = await searchParams;
  const { t } = await getServerT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('auth.verify.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <VerifyEmail token={typeof token === 'string' ? token : undefined} />
      </CardContent>
    </Card>
  );
}
