'use client';

import { useRouter } from 'next/navigation';
import { startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Shown when a page (including the dashboard layout's session check) fails to render, most
 * often because the API is unreachable. Retrying re-runs the server render.
 */
export default function PageError({ reset }: { error: Error; reset: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t('common.pageErrorTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t('errors.SERVICE_UNAVAILABLE')}</p>
          <Button
            onClick={() =>
              startTransition(() => {
                router.refresh();
                reset();
              })
            }
          >
            {t('common.retry')}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
