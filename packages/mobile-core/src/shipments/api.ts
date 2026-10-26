import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateShipmentInput,
  MerchantPickupZoneState,
  Paginated,
  PricingQuote,
  ShipmentDetails,
  ShipmentListItem,
  ShipmentStatus,
  TransitionShipmentRequest,
  ZoneItem,
} from '@coobra/shared';
import { useApi } from '../api-context';
import { useMobileConfig } from '../config';
import { useSessionStore } from '../state/session-store';

const PAGE_SIZE = 20;

/** Merchants and drivers use their own API scopes; the API enforces ownership on each. */
function useShipmentScope() {
  const { clientApp } = useMobileConfig();
  return {
    clientApp,
    basePath: clientApp === 'MERCHANT_APP' ? '/v1/merchant/shipments' : '/v1/driver/shipments',
  };
}

export interface ShipmentListFilters {
  q?: string;
  status?: ShipmentStatus;
  scope?: 'active' | 'history';
}

export function useShipmentList(filters: ShipmentListFilters) {
  const api = useApi();
  const { clientApp, basePath } = useShipmentScope();
  return useInfiniteQuery({
    queryKey: ['shipments', clientApp, 'list', filters],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ page: String(pageParam), pageSize: String(PAGE_SIZE) });
      if (filters.q) query.set('q', filters.q);
      if (filters.status) query.set('status', filters.status);
      if (filters.scope) query.set('scope', filters.scope);
      return api.request<Paginated<ShipmentListItem>>(`${basePath}?${query}`);
    },
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
  });
}

export function useShipment(id: string) {
  const api = useApi();
  const { clientApp, basePath } = useShipmentScope();
  return useQuery({
    queryKey: ['shipments', clientApp, 'detail', id],
    queryFn: () => api.request<ShipmentDetails>(`${basePath}/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });
}

export function useCreateShipment() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { clientApp, basePath } = useShipmentScope();
  return useMutation({
    mutationFn: (input: CreateShipmentInput) =>
      api.request<ShipmentDetails>(basePath, { method: 'POST', body: input }),
    onSuccess: (shipment) => {
      queryClient.setQueryData(['shipments', clientApp, 'detail', shipment.id], shipment);
      void queryClient.invalidateQueries({ queryKey: ['shipments', clientApp, 'list'] });
    },
  });
}

export function useShipmentTransition(id: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { clientApp, basePath } = useShipmentScope();
  return useMutation({
    mutationFn: (input: TransitionShipmentRequest) =>
      api.request<ShipmentDetails>(`${basePath}/${encodeURIComponent(id)}/transitions`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (shipment) => {
      queryClient.setQueryData(['shipments', clientApp, 'detail', id], shipment);
      void queryClient.invalidateQueries({ queryKey: ['shipments', clientApp, 'list'] });
    },
    onError: () => {
      // Someone else may have changed the shipment: show the latest state.
      void queryClient.invalidateQueries({ queryKey: ['shipments', clientApp, 'detail', id] });
    },
  });
}

/** Active zones (destinations and pickup areas). Rarely changes, so cached for 10 minutes. */
export function useZones() {
  const api = useApi();
  return useQuery({
    queryKey: ['zones'],
    queryFn: () => api.request<ZoneItem[]>('/v1/zones'),
    staleTime: 10 * 60_000,
  });
}

/** A single-use merchant quote; pass its id when creating the shipment. */
export function useQuote() {
  const api = useApi();
  return useMutation({
    // Priced from the merchant's approved pickup zone; the origin is never chosen here.
    mutationFn: (input: { destinationZoneId: string }) =>
      api.request<PricingQuote>('/v1/merchant/pricing/quote', { method: 'POST', body: input }),
  });
}

const PICKUP_ZONE_KEY = ['merchant', 'pickup-zone'];

/** Keeps the signed-in merchant's approved zone in the session in step with the server. */
function syncApprovedZone(state: MerchantPickupZoneState) {
  const { user, setUser } = useSessionStore.getState();
  if (user?.merchant && user.merchant.pickupZoneId !== state.approvedZoneId) {
    setUser({ ...user, merchant: { ...user.merchant, pickupZoneId: state.approvedZoneId } });
  }
  return state;
}

/** The approved pickup zone (prices use it) and any change waiting for staff approval. */
export function usePickupZone() {
  const api = useApi();
  return useQuery({
    queryKey: PICKUP_ZONE_KEY,
    queryFn: async () =>
      syncApprovedZone(await api.request<MerchantPickupZoneState>('/v1/merchant/pickup-zone')),
  });
}

/** Asks for a new pickup zone; it only takes effect once staff approve it. */
export function useRequestPickupZone() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (zoneId: string) =>
      api.request<MerchantPickupZoneState>('/v1/merchant/pickup-zone', {
        method: 'PUT',
        body: { zoneId },
      }),
    onSuccess: (state) => queryClient.setQueryData(PICKUP_ZONE_KEY, syncApprovedZone(state)),
  });
}

export function useWithdrawPickupZone() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.request<MerchantPickupZoneState>('/v1/merchant/pickup-zone/request', {
        method: 'DELETE',
      }),
    onSuccess: (state) => queryClient.setQueryData(PICKUP_ZONE_KEY, syncApprovedZone(state)),
  });
}
