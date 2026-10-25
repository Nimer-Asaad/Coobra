import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { LanguageSwitch } from '@/components/language-switch';
import { getChosenLanguage, getServerT } from '@/lib/i18n-server';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  if (!(await getChosenLanguage())) redirect('/choose-language');
  const { t } = await getServerT();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-4 py-8 sm:justify-center">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-2xl font-bold tracking-tight text-primary">{t('common.appName')}</p>
          <p className="text-sm text-muted-foreground">{t('apps.admin')}</p>
        </div>
        <LanguageSwitch />
      </div>
      {children}
    </main>
  );
}
