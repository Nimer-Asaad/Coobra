import type { ZoneLabel } from '@coobra/shared';

export { zoneOptions, type ZoneOption } from '@coobra/shared';

export function zoneText(zone: ZoneLabel | null | undefined, language: string): string | null {
  if (!zone) return null;
  return language === 'ar' ? zone.pathAr : zone.pathEn;
}
