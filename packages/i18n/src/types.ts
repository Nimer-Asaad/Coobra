import type { en } from './locales/en.js';

type DeepStringRecord<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringRecord<T[K]>;
};

/** Every locale must provide exactly the keys of the English source locale. */
export type TranslationResource = DeepStringRecord<typeof en>;
