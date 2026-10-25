import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { directionOf } from '@coobra/shared';
import { Providers } from '@/components/providers';
import { getChosenLanguage } from '@/lib/i18n-server';
import './globals.css';

export const metadata: Metadata = {
  title: 'COOBRA',
  description: 'COOBRA delivery management — admin console',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const language = (await getChosenLanguage()) ?? 'en';
  return (
    <html lang={language} dir={directionOf(language)}>
      <body className="min-h-dvh">
        <Providers language={language}>{children}</Providers>
      </body>
    </html>
  );
}
