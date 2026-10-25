import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogoutButton } from '@/components/dashboard/logout-button';
import { navItemsFor } from '@/components/dashboard/nav';
import { LanguageSwitch } from '@/components/language-switch';
import { getCurrentSession } from '@/lib/api-server';
import { getChosenLanguage, getServerT } from '@/lib/i18n-server';

/** Every page in this group requires a valid staff session (re-validated by the API). */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  if (!(await getChosenLanguage())) redirect('/choose-language');
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const { t } = await getServerT();

  return (
    <div className="min-h-dvh">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/dashboard" className="text-xl font-bold text-primary">
            {t('common.appName')}
          </Link>
          <nav className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {navItemsFor(session.user.role).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-2 text-sm font-medium hover:bg-muted"
              >
                {t(item.labelKey)}
              </Link>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-2">
            <LanguageSwitch />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
