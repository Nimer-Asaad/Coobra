import { I18nManager, Platform } from 'react-native';
import { directionOf, isRtlLanguage, type Language } from '@coobra/shared';

/**
 * Applies the layout direction for a language.
 *
 * - Web: sets `dir`/`lang` on <html>; takes effect immediately.
 * - Native: the root view flips immediately through the `direction` style (see CoobraRoot),
 *   and I18nManager is updated so native-level behaviour (navigation gestures, system
 *   controls) follows after the next app restart. Returns whether a restart is needed.
 */
export function applyDirection(language: Language): { restartRequired: boolean } {
  const rtl = isRtlLanguage(language);
  if (Platform.OS === 'web') {
    if (typeof document !== 'undefined') {
      document.documentElement.dir = directionOf(language);
      document.documentElement.lang = language;
    }
    return { restartRequired: false };
  }
  I18nManager.allowRTL(true);
  I18nManager.swapLeftAndRightInRTL(true);
  if (I18nManager.isRTL !== rtl) {
    I18nManager.forceRTL(rtl);
    return { restartRequired: true };
  }
  return { restartRequired: false };
}

/**
 * Physical text alignment for the language. Native RTL mode swaps left/right,
 * so the value is corrected to render on the intended side either way.
 */
export function textAlignFor(language: Language): 'left' | 'right' {
  const wantRight = isRtlLanguage(language);
  const swapped = Platform.OS !== 'web' && I18nManager.isRTL;
  return wantRight !== swapped ? 'right' : 'left';
}
