import { directionOf, type Language } from '@coobra/shared';
import { textAlignFor } from '../direction';
import { useLanguageStore } from '../state/language-store';

export function useDirection() {
  const language: Language = useLanguageStore((state) => state.language) ?? 'en';
  return { language, direction: directionOf(language), textAlign: textAlignFor(language) };
}
