import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import type {
  CodShortfallItem,
  DriverFinanceSummary,
  MerchantFinanceSummary,
  PaymentMethod,
} from '@coobra/shared';
import { newIdempotencyKey } from '../api-client';
import { useApi } from '../api-context';
import { useMobileConfig } from '../config';

/**
 * One Idempotency-Key per user action: a retry after a network error reuses it, so the server
 * never applies the same money action twice. A new key is made after success.
 */
function useActionKey() {
  const key = useRef<string | null>(null);
  return {
    get: () => (key.current ??= newIdempotencyKey()),
    reset: () => {
      key.current = null;
    },
  };
}

export function useMerchantFinance() {
  const api = useApi();
  return useQuery({
    queryKey: ['finance', 'merchant'],
    queryFn: () => api.request<MerchantFinanceSummary>('/v1/merchant/finance'),
  });
}

export function useMerchantShortfalls() {
  const api = useApi();
  return useQuery({
    queryKey: ['finance', 'merchant', 'shortfalls'],
    queryFn: () => api.request<CodShortfallItem[]>('/v1/merchant/finance/shortfalls'),
  });
}

export function useRequestPayout() {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = useActionKey();
  return useMutation({
    mutationFn: (input: { amount: string; method: PaymentMethod; note?: string }) =>
      api.request('/v1/merchant/finance/payouts', {
        method: 'POST',
        body: input,
        idempotencyKey: key.get(),
      }),
    onSuccess: () => {
      key.reset();
      void queryClient.invalidateQueries({ queryKey: ['finance', 'merchant'] });
    },
  });
}

export function useWithdrawPayout() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; note: string }) =>
      api.request(`/v1/merchant/finance/payouts/${input.id}/cancel`, {
        method: 'POST',
        body: { note: input.note },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['finance', 'merchant'] }),
  });
}

export function useRespondShortfall() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; accept: boolean; note?: string }) =>
      api.request(
        `/v1/merchant/finance/shortfalls/${input.id}/${input.accept ? 'accept' : 'decline'}`,
        {
          method: 'POST',
          body: { note: input.note },
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['finance', 'merchant'] });
      void queryClient.invalidateQueries({ queryKey: ['shipments'] });
    },
  });
}

export function useDriverFinance() {
  const api = useApi();
  return useQuery({
    queryKey: ['finance', 'driver'],
    queryFn: () => api.request<DriverFinanceSummary>('/v1/driver/finance'),
  });
}

export function useSubmitSettlement() {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = useActionKey();
  return useMutation({
    mutationFn: (input: { declaredAmount: string; note?: string }) =>
      api.request('/v1/driver/finance/settlements', {
        method: 'POST',
        body: input,
        idempotencyKey: key.get(),
      }),
    onSuccess: () => {
      key.reset();
      void queryClient.invalidateQueries({ queryKey: ['finance', 'driver'] });
    },
  });
}

/** A later payment on a partially paid shipment (driver app). */
export function useFollowUpCollection(shipmentId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { clientApp } = useMobileConfig();
  const key = useActionKey();
  return useMutation({
    mutationFn: (input: { amount: string; note?: string }) =>
      api.request(`/v1/driver/shipments/${shipmentId}/collections`, {
        method: 'POST',
        body: input,
        idempotencyKey: key.get(),
      }),
    onSuccess: () => {
      key.reset();
      void queryClient.invalidateQueries({
        queryKey: ['shipments', clientApp, 'detail', shipmentId],
      });
      void queryClient.invalidateQueries({ queryKey: ['finance', 'driver'] });
    },
  });
}
