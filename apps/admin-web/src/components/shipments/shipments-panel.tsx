'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import {
  GOVERNORATES,
  SHIPMENT_STATUSES,
  type DriverOption,
  type MerchantOption,
  type Paginated,
  type ShipmentListItem,
  type ShipmentStatus,
  type ShipmentSummary,
} from '@coobra/shared';
import { ErrorAlert } from '@/components/error-alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { bff } from '@/lib/api-client';
import { formatDateTime, formatMoney, startOfLocalDay, startOfNextLocalDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import { StatusBadge, STATUS_STYLES } from './status-badge';

const PAGE_SIZE = 20;
/** Statuses that need day-to-day attention, shown as counters above the list. */
const OPERATIONAL_STATUSES: ShipmentStatus[] = [
  'CREATED',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
  'DELIVERED',
];
const FILTER_KEYS = ['q', 'status', 'governorate', 'merchantId', 'driverId', 'from', 'to'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

export function ShipmentsPanel({ canManage }: { canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const filters = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, params.get(key) ?? '']),
  ) as Record<FilterKey, string>;

  const apiQuery = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  for (const key of ['q', 'status', 'governorate', 'merchantId', 'driverId'] as const) {
    if (filters[key]) apiQuery.set(key, filters[key]);
  }
  if (filters.from) apiQuery.set('createdFrom', startOfLocalDay(filters.from));
  if (filters.to) apiQuery.set('createdTo', startOfNextLocalDay(filters.to));

  const shipments = useQuery({
    queryKey: ['admin', 'shipments', apiQuery.toString()],
    queryFn: () => bff<Paginated<ShipmentListItem>>(`/v1/admin/shipments?${apiQuery}`),
    placeholderData: (previous) => previous,
  });
  const summary = useQuery({
    queryKey: ['admin', 'shipments', 'summary'],
    queryFn: () => bff<ShipmentSummary>('/v1/admin/shipments/summary'),
  });
  const merchants = useQuery({
    queryKey: ['admin', 'merchants', ''],
    queryFn: () => bff<MerchantOption[]>('/v1/admin/merchants'),
  });
  const drivers = useQuery({
    queryKey: ['admin', 'drivers', ''],
    queryFn: () => bff<DriverOption[]>('/v1/admin/drivers'),
  });

  function navigate(next: Record<string, string>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value) query.set(key, value);
    router.replace(query.size ? `${pathname}?${query}` : pathname);
  }

  const totalPages = shipments.data ? Math.max(1, Math.ceil(shipments.data.total / PAGE_SIZE)) : 1;
  const hasFilters = FILTER_KEYS.some((key) => filters[key]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('shipments.title')}</h1>
        {canManage ? (
          <Button asChild>
            <Link href="/shipments/new">{t('shipments.newShipment')}</Link>
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <SummaryTile
          label={t('shipments.summary.total')}
          value={summary.data?.total}
          active={!filters.status}
          onClick={() => navigate({ ...filters, status: '' })}
        />
        {OPERATIONAL_STATUSES.map((status) => (
          <SummaryTile
            key={status}
            label={t(`shipmentStatus.${status}`)}
            value={summary.data?.counts[status]}
            className={STATUS_STYLES[status]}
            active={filters.status === status}
            onClick={() => navigate({ ...filters, status })}
          />
        ))}
      </div>

      <Card>
        <CardContent className="pt-6">
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              navigate(
                Object.fromEntries(FILTER_KEYS.map((key) => [key, String(form.get(key) ?? '')])),
              );
            }}
            // Re-mount when the URL changes so the inputs show the applied filters.
            key={params.toString()}
          >
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="q">{t('shipments.search')}</Label>
              <Input
                id="q"
                name="q"
                type="search"
                defaultValue={filters.q}
                placeholder={t('shipments.searchPlaceholder')}
              />
            </div>
            <FilterSelect
              name="status"
              label={t('shipments.filters.status')}
              value={filters.status}
            >
              <option value="">{t('shipments.filters.allStatuses')}</option>
              {SHIPMENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`shipmentStatus.${status}`)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              name="governorate"
              label={t('shipments.filters.governorate')}
              value={filters.governorate}
            >
              <option value="">{t('shipments.filters.allGovernorates')}</option>
              {GOVERNORATES.map((code) => (
                <option key={code} value={code}>
                  {t(`governorates.${code}`)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              name="merchantId"
              label={t('shipments.filters.merchant')}
              value={filters.merchantId}
            >
              <option value="">{t('shipments.filters.allMerchants')}</option>
              {merchants.data?.map((merchant) => (
                <option key={merchant.id} value={merchant.id}>
                  {merchant.businessName}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              name="driverId"
              label={t('shipments.filters.driver')}
              value={filters.driverId}
            >
              <option value="">{t('shipments.filters.allDrivers')}</option>
              {drivers.data?.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.fullName}
                </option>
              ))}
            </FilterSelect>
            <div className="flex flex-col gap-2">
              <Label htmlFor="from">{t('shipments.filters.from')}</Label>
              <Input id="from" name="from" type="date" defaultValue={filters.from} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="to">{t('shipments.filters.to')}</Label>
              <Input id="to" name="to" type="date" defaultValue={filters.to} />
            </div>
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
              <Button type="submit">{t('shipments.filters.apply')}</Button>
              {hasFilters ? (
                <Button type="button" variant="ghost" onClick={() => navigate({})}>
                  {t('shipments.filters.clear')}
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {shipments.isPending ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : shipments.isError ? (
            <ErrorAlert error={shipments.error} />
          ) : shipments.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {hasFilters ? t('shipments.noResults') : t('shipments.empty')}
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {t('shipments.total', { count: shipments.data.total })}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[56rem] text-sm">
                  <thead className="border-b text-start text-muted-foreground">
                    <tr>
                      <th className="py-2 text-start font-medium">
                        {t('shipments.fields.trackingNumber')}
                      </th>
                      <th className="py-2 text-start font-medium">
                        {t('shipments.fields.status')}
                      </th>
                      <th className="py-2 text-start font-medium">
                        {t('shipments.fields.recipientName')}
                      </th>
                      <th className="py-2 text-start font-medium">
                        {t('shipments.fields.governorate')}
                      </th>
                      <th className="py-2 text-start font-medium">
                        {t('shipments.fields.merchant')}
                      </th>
                      <th className="py-2 text-start font-medium">
                        {t('shipments.fields.driver')}
                      </th>
                      <th className="py-2 text-start font-medium">
                        {t('shipments.details.codAmount')}
                      </th>
                      <th className="py-2 text-start font-medium">
                        {t('shipments.fields.createdAt')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {shipments.data.items.map((shipment) => (
                      <tr key={shipment.id} className="hover:bg-muted/50">
                        <td className="py-2.5 pe-3">
                          <Link
                            href={`/shipments/${shipment.id}`}
                            className="font-mono font-medium text-primary hover:underline"
                            dir="ltr"
                          >
                            {shipment.trackingNumber}
                          </Link>
                        </td>
                        <td className="py-2.5 pe-3">
                          <StatusBadge status={shipment.status} />
                        </td>
                        <td className="py-2.5 pe-3">
                          <div className="font-medium">{shipment.recipientName}</div>
                          <div className="text-xs text-muted-foreground" dir="ltr">
                            {shipment.recipientPhone}
                          </div>
                        </td>
                        <td className="py-2.5 pe-3">
                          {t(`governorates.${shipment.governorate}`)}
                          <div className="text-xs text-muted-foreground">{shipment.city}</div>
                        </td>
                        <td className="py-2.5 pe-3">{shipment.merchant.businessName}</td>
                        <td className="py-2.5 pe-3">
                          {shipment.driver?.fullName ?? (
                            <span className="text-muted-foreground">
                              {t('shipments.fields.unassigned')}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pe-3 whitespace-nowrap">
                          {formatMoney(shipment.codAmount, i18n.language, shipment.currency)}
                        </td>
                        <td className="py-2.5 whitespace-nowrap text-muted-foreground">
                          {formatDateTime(shipment.createdAt, i18n.language)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => navigate({ ...filters, page: String(page - 1) })}
                >
                  {t('shipments.previous')}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {t('shipments.pageOf', { page, pages: totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => navigate({ ...filters, page: String(page + 1) })}
                >
                  {t('shipments.next')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  active,
  className,
  onClick,
}: {
  label: string;
  value: number | undefined;
  active: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col items-start gap-1 rounded-lg border bg-card p-3 text-start transition-colors hover:border-primary',
        active && 'border-primary ring-2 ring-primary/30',
      )}
    >
      <span className={cn('rounded px-1.5 text-xs font-medium', className)}>{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value ?? '–'}</span>
    </button>
  );
}

function FilterSelect({
  name,
  label,
  value,
  children,
}: {
  name: string;
  label: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <NativeSelect id={name} name={name} defaultValue={value}>
        {children}
      </NativeSelect>
    </div>
  );
}
