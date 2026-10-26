'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReturnListItem } from '@coobra/shared';
import { ErrorAlert } from '@/components/error-alert';
import { StatusBadge } from '@/components/shipments/status-badge';
import { Card, CardContent } from '@/components/ui/card';
import { bff } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ReturnInfoBlock } from './return-actions';

export function ReturnsPanel({
  canApprove,
  canDecideFee,
}: {
  canApprove: boolean;
  canDecideFee: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const key = ['admin', 'returns', open];
  const returns = useQuery({
    queryKey: key,
    queryFn: () => bff<ReturnListItem[]>(`/v1/admin/returns?open=${open}`),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('returns.title')}</h1>
        <div className="flex gap-1 rounded-lg border bg-card p-1">
          {[true, false].map((value) => (
            <button
              key={String(value)}
              onClick={() => setOpen(value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                open === value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
            >
              {value ? t('returns.open') : t('returns.all')}
            </button>
          ))}
        </div>
      </div>
      {returns.isError ? <ErrorAlert error={returns.error} /> : null}
      {returns.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('returns.empty')}</p>
      ) : null}
      <div className="flex flex-col gap-4">
        {returns.data?.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex flex-col gap-3 pt-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/shipments/${item.shipment.id}`}
                    className="font-mono font-semibold text-primary"
                    dir="ltr"
                  >
                    {item.shipment.trackingNumber}
                  </Link>
                  <StatusBadge status={item.shipment.status} />
                </div>
                <span className="text-sm text-muted-foreground">
                  {item.merchant.businessName} · {item.shipment.recipientName}
                </span>
              </div>
              <ReturnInfoBlock
                shipmentId={item.shipment.id}
                shipmentStatus={item.shipment.status}
                info={item}
                canApprove={canApprove}
                canDecideFee={canDecideFee}
                invalidate={[
                  ['admin', 'returns'],
                  ['admin', 'shipments'],
                ]}
              />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
