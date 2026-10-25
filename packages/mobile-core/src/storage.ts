import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Small persistence layer.
 * - Native: values live in the OS keystore/keychain via expo-secure-store.
 * - Web: only non-sensitive preferences use localStorage. Session tokens are NEVER
 *   stored on web; the API keeps them in an httpOnly cookie instead.
 */
const isWeb = Platform.OS === 'web';

export const storage = {
  async get(key: string): Promise<string | null> {
    if (isWeb) {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (isWeb) {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // Storage can be unavailable (private mode); the preference is then per-session.
      }
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (isWeb) {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // ignore
      }
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export const STORAGE_KEYS = {
  language: 'coobra.language',
  sessionToken: 'coobra.sessionToken',
} as const;

export const usesCookieSessions = isWeb;
