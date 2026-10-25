'use client';

import { useTranslation } from 'react-i18next';
import type { ShipmentStatus } from '@coobra/shared';
import { cn } from '@/lib/utils';

export const STATUS_STYLES: Record<ShipmentStatus, string> = {
  CREATED: 'bg-slate-100 text-slate-800',
  ASSIGNED: 'bg-sky-100 text-sky-900',
  PICKED_UP: 'bg-indigo-100 text-indigo-900',
  OUT_FOR_DELIVERY: 'bg-amber-100 text-amber-900',
  DELIVERED: 'bg-emerald-100 text-emerald-900',
  DELIVERY_FAILED: 'bg-red-100 text-red-900',
  RETURN_REQUESTED: 'bg-orange-100 text-orange-900',
  RETURNED: 'bg-zinc-200 text-zinc-800',
  CANCELLED: 'bg-zinc-100 text-zinc-500',
};

export function StatusBadge({ status, className }: { status: ShipmentStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        STATUS_STYLES[status],
        className,
      )}
    >
      {t(`shipmentStatus.${status}`)}
    </span>
  );
}
