/** Arabic UI with Latin digits: tracking numbers, phones and amounts stay easy to read and copy. */
function intlLocale(language: string): string {
  return language === 'ar' ? 'ar-PS-u-nu-latn' : 'en-GB';
}

export function formatMoney(amount: string, language: string, currency = 'ILS'): string {
  return new Intl.NumberFormat(intlLocale(language), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number(amount));
}

export function formatDateTime(value: string, language: string): string {
  return new Intl.DateTimeFormat(intlLocale(language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

/** `YYYY-MM-DD` from a date input, as the start of that day in the browser's time zone. */
export function startOfLocalDay(date: string): string {
  return new Date(`${date}T00:00:00`).toISOString();
}

/** The start of the day after `date` (exclusive upper bound). */
export function startOfNextLocalDay(date: string): string {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** `m:ss` for a countdown (Latin digits in both languages; render it inside `dir="ltr"`). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
