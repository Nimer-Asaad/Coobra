import { LanguagePicker } from '@/components/language-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerT } from '@/lib/i18n-server';

export default async function SettingsPage() {
  const { t } = await getServerT();
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t('language.label')}</CardTitle>
        </CardHeader>
        <CardContent>
          <LanguagePicker next="/settings" />
        </CardContent>
      </Card>
    </div>
  );
}
