import { useMutation } from '@tanstack/react-query';
import type {
  AuthUser,
  ForgotPasswordInput,
  Language,
  LoginResponse,
  MeResponse,
  MessageResponse,
  RegisterMerchantInput,
  ResetPasswordInput,
} from '@coobra/shared';
import { useApi } from './api-context';
import { useMobileConfig } from './config';
import { useLanguageStore } from './state/language-store';
import { useSessionStore } from './state/session-store';

/** Keeps the account's language (used for emails) aligned with the language chosen in the app. */
function useSyncLanguage() {
  const api = useApi();
  return async (user: AuthUser): Promise<AuthUser> => {
    const language = useLanguageStore.getState().language;
    if (!language || language === user.language) return user;
    return api
      .request<AuthUser>('/v1/me/preferences', { method: 'PATCH', body: { language } })
      .catch(() => user);
  };
}

export function useLogin() {
  const api = useApi();
  const { clientApp } = useMobileConfig();
  const syncLanguage = useSyncLanguage();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.request<LoginResponse>('/v1/auth/login', {
        method: 'POST',
        body: { ...input, clientApp },
      }),
    onSuccess: async ({ user, token }) => {
      await useSessionStore.getState().signIn(user, token);
      useSessionStore.getState().setUser(await syncLanguage(user));
    },
  });
}

export function useRegisterMerchant() {
  const api = useApi();
  return useMutation({
    mutationFn: (input: RegisterMerchantInput) =>
      api.request<LoginResponse>('/v1/auth/register', { method: 'POST', body: input }),
    onSuccess: ({ user, token }) => useSessionStore.getState().signIn(user, token),
  });
}

export function useLogout() {
  const api = useApi();
  return useMutation({
    mutationFn: () => api.request<void>('/v1/auth/logout', { method: 'POST' }),
    // Always clear the local session, even if the server is unreachable.
    onSettled: () => useSessionStore.getState().signOut(),
  });
}

export function useRefreshMe() {
  const api = useApi();
  return useMutation({
    mutationFn: () => api.request<MeResponse>('/v1/auth/me'),
    onSuccess: ({ user }) => useSessionStore.getState().setUser(user),
  });
}

export function useForgotPassword() {
  const api = useApi();
  return useMutation({
    mutationFn: (input: ForgotPasswordInput) =>
      api.request<MessageResponse>('/v1/auth/forgot-password', { method: 'POST', body: input }),
  });
}

export function useResetPassword() {
  const api = useApi();
  return useMutation({
    mutationFn: (input: ResetPasswordInput) =>
      api.request<MessageResponse>('/v1/auth/reset-password', { method: 'POST', body: input }),
  });
}

export function useVerifyEmail() {
  const api = useApi();
  return useMutation({
    mutationFn: async (token: string) => {
      await api.request<MessageResponse>('/v1/auth/verify-email', {
        method: 'POST',
        body: { token },
      });
      // If this device is signed in, refresh the cached user so it is no longer "unverified".
      if (useSessionStore.getState().status === 'signedIn') {
        const { user } = await api.request<MeResponse>('/v1/auth/me').catch(() => ({ user: null }));
        if (user) useSessionStore.getState().setUser(user);
      }
    },
  });
}

export function useResendVerification() {
  const api = useApi();
  return useMutation({
    mutationFn: () =>
      api.request<MessageResponse>('/v1/auth/resend-verification', { method: 'POST' }),
  });
}

/** Changes the UI language locally and, when signed in, on the account. */
export function useChangeLanguage() {
  const api = useApi();
  return useMutation({
    mutationFn: async (language: Language) => {
      await useLanguageStore.getState().setLanguage(language);
      if (useSessionStore.getState().status === 'signedIn') {
        const user = await api.request<AuthUser>('/v1/me/preferences', {
          method: 'PATCH',
          body: { language },
        });
        useSessionStore.getState().setUser(user);
      }
    },
  });
}
