import { create } from 'zustand';
import { isLanguage, type Language } from '@coobra/shared';
import { applyDirection } from '../direction';
import { storage, STORAGE_KEYS } from '../storage';

interface LanguageState {
  /** Null until the user has chosen a language on first launch. */
  language: Language | null;
  hydrated: boolean;
  /** Native only: the app must restart to fully switch the system layout direction. */
  restartRequired: boolean;
  hydrate: () => Promise<void>;
  setLanguage: (language: Language) => Promise<void>;
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: null,
  hydrated: false,
  restartRequired: false,
  hydrate: async () => {
    const stored = await storage.get(STORAGE_KEYS.language).catch(() => null);
    const language = isLanguage(stored) ? stored : null;
    if (language) applyDirection(language);
    set({ language, hydrated: true });
  },
  setLanguage: async (language) => {
    await storage.set(STORAGE_KEYS.language, language);
    const { restartRequired } = applyDirection(language);
    set({ language, restartRequired });
  },
}));
