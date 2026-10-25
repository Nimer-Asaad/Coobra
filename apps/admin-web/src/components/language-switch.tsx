'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useTranslation } from 'react-i18next';
import type { Language } from '@coobra/shared';
import { setLanguageAction } from '@/app/actions/language';
import { Button } from '@/components/ui/button';

/** Toggles between Arabic and English; the page re-renders with the new direction. */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const target: Language = i18n.language === 'ar' ? 'en' : 'ar';

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      lang={target}
      onClick={() =>
        startTransition(async () => {
          await setLanguageAction(target);
          router.refresh();
        })
      }
    >
      {target === 'ar' ? t('language.arabic') : t('language.english')}
    </Button>
  );
}
