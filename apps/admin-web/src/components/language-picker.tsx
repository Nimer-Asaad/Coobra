'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { SUPPORTED_LANGUAGES, type Language } from '@coobra/shared';
import { setLanguageAction } from '@/app/actions/language';
import { Button } from '@/components/ui/button';

const LABELS: Record<Language, string> = { ar: 'العربية', en: 'English' };

/** First-launch language choice. Labels are shown in their own language. */
export function LanguagePicker({ next }: { next: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(language: Language) {
    startTransition(async () => {
      await setLanguageAction(language);
      router.replace(next);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {SUPPORTED_LANGUAGES.map((language) => (
        <Button
          key={language}
          size="lg"
          variant="outline"
          disabled={pending}
          onClick={() => choose(language)}
          lang={language}
          dir={language === 'ar' ? 'rtl' : 'ltr'}
          className="h-14 text-lg"
        >
          {LABELS[language]}
        </Button>
      ))}
    </div>
  );
}
