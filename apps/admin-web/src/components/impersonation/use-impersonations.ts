'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ImpersonationInfo } from '@coobra/shared';
import { bff } from '@/lib/api-client';

export const ACTIVE_IMPERSONATIONS_KEY = ['admin', 'impersonations', 'active'];

/** Active impersonations (every admin's), refreshed every 30 seconds and on focus. */
export function useActiveImpersonations(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ACTIVE_IMPERSONATIONS_KEY,
    queryFn: async () => ({
      items: await bff<ImpersonationInfo[]>('/v1/admin/impersonations?active=true'),
      receivedAt: Date.now(),
    }),
    refetchInterval: 30_000,
  });
}

export function useEndImpersonation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      bff<ImpersonationInfo>(`/v1/admin/impersonations/${id}/end`, { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ACTIVE_IMPERSONATIONS_KEY }),
  });
}

/**
 * Milliseconds left until `expiresAt`, by the server's clock: `serverNow` was the server time
 * when the response was received at `receivedAt` (local), so a wrong local clock does not matter.
 */
export function useRemaining(
  info: Pick<ImpersonationInfo, 'expiresAt' | 'serverNow'>,
  receivedAt: number,
) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const offset = Date.parse(info.serverNow) - receivedAt;
  return Date.parse(info.expiresAt) - (now + offset);
}
