import { create } from 'zustand';
import type { AuthUser } from '@coobra/shared';
import { storage, STORAGE_KEYS, usesCookieSessions } from '../storage';

export type SessionStatus = 'unknown' | 'offline' | 'signedOut' | 'signedIn';

interface SessionState {
  status: SessionStatus;
  user: AuthUser | null;
  /** Native only. On web the session lives in an httpOnly cookie. */
  token: string | null;
  loadToken: () => Promise<string | null>;
  signIn: (user: AuthUser, token?: string) => Promise<void>;
  setUser: (user: AuthUser) => void;
  setStatus: (status: SessionStatus) => void;
  signOut: () => Promise<void>;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'unknown',
  user: null,
  token: null,
  loadToken: async () => {
    if (usesCookieSessions) return null;
    const token = await storage.get(STORAGE_KEYS.sessionToken).catch(() => null);
    set({ token });
    return token;
  },
  signIn: async (user, token) => {
    if (token && !usesCookieSessions) await storage.set(STORAGE_KEYS.sessionToken, token);
    set({ status: 'signedIn', user, token: token ?? null });
  },
  setUser: (user) => set({ user }),
  setStatus: (status) => set({ status }),
  signOut: async () => {
    await storage.remove(STORAGE_KEYS.sessionToken).catch(() => undefined);
    set({ status: 'signedOut', user: null, token: null });
  },
}));
