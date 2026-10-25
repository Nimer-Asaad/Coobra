import { LanguagePicker } from '@/components/language-picker';

/** First launch: the language must be chosen before any authentication screen. */
export default function ChooseLanguagePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-4 py-10">
      <div className="flex flex-col gap-2 text-center">
        <p className="text-3xl font-bold tracking-tight text-primary">COOBRA</p>
        <h1 className="text-xl font-semibold" lang="ar" dir="rtl">
          اختر لغتك
        </h1>
        <p className="text-xl font-semibold" lang="en" dir="ltr">
          Choose your language
        </p>
      </div>
      <LanguagePicker next="/login" />
    </main>
  );
}
