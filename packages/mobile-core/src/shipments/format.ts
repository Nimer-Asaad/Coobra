import type { Language, ZoneLabel } from '@coobra/shared';

/** Arabic text with Latin digits so amounts, phones and tracking numbers stay easy to read. */
function intlLocale(language: Language): string {
  return language === 'ar' ? 'ar-PS-u-nu-latn' : 'en-GB';
}

export function formatMoney(amount: string, language: Language): string {
  try {
    return new Intl.NumberFormat(intlLocale(language), {
      style: 'currency',
      currency: 'ILS',
      minimumFractionDigits: 2,
    }).format(Number(amount));
  } catch {
    return `${amount} ₪`;
  }
}

export function formatDateTime(value: string, language: Language): string {
  try {
    return new Intl.DateTimeFormat(intlLocale(language), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value.slice(0, 16).replace('T', ' ');
  }
}

export function zoneText(zone: ZoneLabel | null | undefined, language: Language): string | null {
  if (!zone) return null;
  return language === 'ar' ? zone.pathAr : zone.pathEn;
}
