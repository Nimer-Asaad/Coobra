'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CASH_CHANNELS,
  CASH_COUNT_ROLES,
  PAYMENT_METHODS,
  PROPOSABLE_SHORTFALL_RESOLUTIONS,
  SETTLEMENT_RECORDER_ROLES,
  type AdjustmentItem,
  type CodShortfallItem,
  type DriverBalanceRow,
  type DriverOption,
  type DriverShortageItem,
  type FinanceOverview,
  type FinanceSettingItem,
  type MerchantAdjustmentTotals,
  type MerchantBalanceRow,
  type PayoutItem,
  type SettlementItem,
  type UserRole,
} from '@coobra/shared';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { bff } from '@/lib/api-client';
import { formatDateTime, startOfLocalDay, startOfNextLocalDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Amount, InlineAction, StatusPill, useFieldError, useFinanceAction } from './common';

type Tab = 'overview' | 'drivers' | 'merchants' | 'reviews';
const FIN = ['admin', 'finance'];

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** POST through the BFF with the action's Idempotency-Key (ignored where not needed). */
function useBffPost(path: string, withKey = true) {
  return useFinanceAction((body: object, idempotencyKey: string) =>
    bff(path, { method: 'POST', body, idempotencyKey: withKey ? idempotencyKey : undefined }),
  );
}
const optional = (form: FormData, key: string) => text(form, key) || undefined;

const hasRole = (roles: readonly UserRole[], role: UserRole) => roles.includes(role);

/**
 * What a role may do on the Driver cash tab. Display only: the API enforces the same rules.
 * - canSeeMoney: custody balances and cash shortages
 * - canManage: approve or reject cash shortages (second finance person)
 * - canRecord: register a hand-over at the counter
 * - canCount: count/confirm settlements, record shortages and post debt repayments
 */
export function driverCashAccess(role: UserRole) {
  const isFinance = role === 'SUPER_ADMIN' || role === 'ACCOUNTANT';
  return {
    canSeeMoney: isFinance || role === 'OWNER_VIEWER',
    canManage: isFinance,
    canRecord: hasRole(SETTLEMENT_RECORDER_ROLES, role),
    canCount: hasRole(CASH_COUNT_ROLES, role),
  };
}

export function FinancePanel({ role, userId }: { role: UserRole; userId: string }) {
  const { t } = useTranslation();
  const isFinance = role === 'SUPER_ADMIN' || role === 'ACCOUNTANT';
  const canView = isFinance || role === 'OWNER_VIEWER';
  // Operations register cash hand-overs (no balances); finance sees everything.
  const tabs: Tab[] = canView
    ? ['overview', 'drivers', 'merchants', 'reviews']
    : role === 'OPERATIONS'
      ? ['drivers', 'reviews']
      : ['reviews'];
  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'reviews');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('finance.title')}</h1>
        <div className="flex flex-wrap gap-1 rounded-lg border bg-card p-1" role="tablist">
          {tabs.map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={tab === item}
              onClick={() => setTab(item)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                tab === item ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
              )}
            >
              {t(`finance.tabs.${item}`)}
            </button>
          ))}
        </div>
      </div>
      {tab === 'overview' ? <OverviewTab isSuperAdmin={role === 'SUPER_ADMIN'} /> : null}
      {tab === 'drivers' ? <DriversTab {...driverCashAccess(role)} userId={userId} /> : null}
      {tab === 'merchants' ? <MerchantsTab canManage={isFinance} /> : null}
      {tab === 'reviews' ? (
        <ReviewsTab
          canDecide={isFinance}
          canPropose={isFinance || role === 'OPERATIONS'}
          canSeeMoney={canView}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">
        <Amount value={value} />
      </p>
    </div>
  );
}

function OverviewTab({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const query = new URLSearchParams();
  if (range.from) query.set('from', startOfLocalDay(range.from));
  if (range.to) query.set('to', startOfNextLocalDay(range.to));
  const overview = useQuery({
    queryKey: [...FIN, 'overview', query.toString()],
    queryFn: () => bff<FinanceOverview>(`/v1/admin/finance/overview?${query}`),
  });
  const settings = useQuery({
    queryKey: [...FIN, 'settings'],
    queryFn: () => bff<FinanceSettingItem[]>('/v1/admin/finance/settings'),
  });
  const threshold = settings.data?.[0];
  const update = useFinanceAction((body: { value: string; reason: string }) =>
    bff('/v1/admin/finance/settings/approval-threshold', { method: 'PUT', body }),
  );
  const fieldError = useFieldError(update.error);

  if (overview.isPending)
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (overview.isError) return <ErrorAlert error={overview.error} />;
  const o = overview.data;
  const reportLinks = [
    ['merchant-balances', 'merchantBalances'],
    ['driver-balances', 'driverBalances'],
    ['journal', 'journal'],
    ['delivered-shipments', 'deliveredShipments'],
    ['merchant-adjustments', 'merchantAdjustments'],
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {CASH_CHANNELS.map((channel) => (
          <Tile
            key={channel}
            label={`${t('finance.companyCash')} · ${t(`finance.channels.${channel}`)}`}
            value={o.companyCash[channel]}
          />
        ))}
        <Tile label={t('finance.driverCustody')} value={o.driverCustody} />
        <Tile label={t('finance.driverReceivables')} value={o.driverReceivables} />
        <Tile label={t('finance.merchantPending')} value={o.merchantPending} />
        <Tile label={t('finance.merchantOwed')} value={o.merchantOwed} />
        <Tile label={t('finance.merchantOwing')} value={o.merchantOwing} />
        <Tile label={t('finance.reservedPayouts')} value={o.reservedPayouts} />
        <Tile label={t('finance.recipientOutstanding')} value={o.recipientOutstanding} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('finance.periodTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setRange({ from: text(form, 'from'), to: text(form, 'to') });
              }}
            >
              <div className="flex flex-col gap-1">
                <Label htmlFor="period-from">{t('shipments.filters.from')}</Label>
                <input
                  id="period-from"
                  name="from"
                  type="date"
                  defaultValue={range.from}
                  className="h-9 rounded-md border px-2"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="period-to">{t('shipments.filters.to')}</Label>
                <input
                  id="period-to"
                  name="to"
                  type="date"
                  defaultValue={range.to}
                  className="h-9 rounded-md border px-2"
                />
              </div>
              <Button size="sm" type="submit" variant="outline">
                {t('finance.apply')}
              </Button>
            </form>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {(
                [
                  'deliveryFees',
                  'returnFees',
                  'codShortfallExpense',
                  'driverCashLossExpense',
                ] as const
              ).map((key) => (
                <div key={key} className="flex justify-between gap-2 rounded bg-muted/50 px-2 py-1">
                  <dt>{t(`finance.${key}`)}</dt>
                  <dd className="font-medium">
                    <Amount value={o.period[key]} />
                  </dd>
                </div>
              ))}
            </dl>
            <MerchantAdjustmentsSummary totals={o.period.merchantAdjustments} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('finance.queuesTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              {Object.entries(o.queues).map(([key, count]) => (
                <li
                  key={key}
                  className="flex justify-between gap-2 rounded px-2 py-1 hover:bg-muted/50"
                >
                  <span>{t(`finance.queues.${key}`)}</span>
                  <StatusPill tone={count > 0 ? 'warn' : 'muted'}>{count}</StatusPill>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('finance.reconciliation')}</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-start font-medium" />
                  <th className="py-1 text-start font-medium">{t('finance.ledger')}</th>
                  <th className="py-1 text-start font-medium">{t('finance.records')}</th>
                  <th className="py-1 text-start font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {o.reconciliation.map((check) => (
                  <tr key={check.key}>
                    <td className="py-1.5">{t(`finance.checks.${check.key}`)}</td>
                    <td>
                      <Amount value={check.ledger} />
                    </td>
                    <td>
                      <Amount value={check.operational} />
                    </td>
                    <td>
                      {check.difference === '0.00' ? (
                        <StatusPill tone="ok">{t('finance.reconciled')}</StatusPill>
                      ) : (
                        <StatusPill tone="bad">
                          {t('finance.notReconciled')}: <Amount value={check.difference} />
                        </StatusPill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('finance.exports')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {reportLinks.map(([file, label]) => (
              <Button key={file} asChild size="sm" variant="outline">
                <a
                  href={`/api/bff/v1/admin/finance/reports/${file}.csv`}
                  download={`coobra-${file}.csv`}
                >
                  {t(`finance.reports.${label}`)}
                </a>
              </Button>
            ))}
          </CardContent>
        </Card>
      </div>

      {threshold ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('finance.threshold')}: <Amount value={threshold.value} />
            </CardTitle>
            <CardDescription>{t('finance.thresholdHint')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {isSuperAdmin ? (
              <InlineAction
                label={t('finance.thresholdSave')}
                pending={update.isPending}
                error={update.error}
                onSubmit={(form) =>
                  update.mutateAsync({ value: text(form, 'value'), reason: text(form, 'reason') })
                }
              >
                <FormField
                  name="value"
                  dir="ltr"
                  inputMode="decimal"
                  label={t('finance.amount')}
                  defaultValue={threshold.value}
                />
                {fieldError('value')}
                <FormField name="reason" label={t('finance.reason')} />
                {fieldError('reason')}
              </InlineAction>
            ) : null}
            {threshold.history.length > 0 ? (
              <ul className="text-sm text-muted-foreground">
                {threshold.history.map((change) => (
                  <li key={change.createdAt}>
                    {formatDateTime(change.createdAt, i18n.language)} · {change.changedBy.fullName}{' '}
                    · <Amount value={change.oldValue} /> → <Amount value={change.newValue} /> ·{' '}
                    {change.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Merchant settlement adjustments, kept apart from revenue and expenses: each direction as a
 * positive amount, and the net with its direction in words (never a negative expense).
 */
export function MerchantAdjustmentsSummary({ totals }: { totals: MerchantAdjustmentTotals }) {
  const { t } = useTranslation();
  const net = totals.net.startsWith('-') ? totals.net.slice(1) : totals.net;
  const netLabel =
    totals.net === '0.00'
      ? t('finance.merchantAdjustments.netNone')
      : totals.net.startsWith('-')
        ? t('finance.merchantAdjustments.netDebit')
        : t('finance.merchantAdjustments.netCredit');
  return (
    <section aria-labelledby="merchant-adjustments-title" className="flex flex-col gap-2">
      <h3 id="merchant-adjustments-title" className="text-sm font-medium">
        {t('finance.merchantAdjustments.title')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('finance.merchantAdjustments.hint')}</p>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div className="flex justify-between gap-2 rounded bg-muted/50 px-2 py-1">
          <dt>{t('finance.merchantAdjustments.credits', { count: totals.creditCount })}</dt>
          <dd className="font-medium">
            <Amount value={totals.credits} />
          </dd>
        </div>
        <div className="flex justify-between gap-2 rounded bg-muted/50 px-2 py-1">
          <dt>{t('finance.merchantAdjustments.debits', { count: totals.debitCount })}</dt>
          <dd className="font-medium">
            <Amount value={totals.debits} />
          </dd>
        </div>
        <div className="flex justify-between gap-2 rounded bg-muted/50 px-2 py-1">
          <dt>{netLabel}</dt>
          <dd className="font-medium">
            <Amount value={net} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Driver cash
// ---------------------------------------------------------------------------

function ChannelSelect({ name = 'channel', label }: { name?: string; label: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <NativeSelect name={name} defaultValue="HUB" aria-label={label}>
        {CASH_CHANNELS.map((channel) => (
          <option key={channel} value={channel}>
            {t(`finance.channels.${channel}`)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

/**
 * Driver cash. Operations and finance register hand-overs; only an accountant (never the one
 * who registered it) counts and confirms or rejects them, and records cash discrepancies.
 */
export function DriversTab({
  canSeeMoney,
  canManage,
  canRecord,
  canCount,
  userId,
}: {
  canSeeMoney: boolean;
  canManage: boolean;
  canRecord: boolean;
  canCount: boolean;
  userId: string;
}) {
  const { t, i18n } = useTranslation();
  const drivers = useQuery({
    queryKey: [...FIN, 'drivers'],
    queryFn: () => bff<DriverBalanceRow[]>('/v1/admin/finance/drivers'),
    enabled: canSeeMoney,
  });
  // Without balance access (operations) the driver list comes from the shipments directory.
  const driverOptions = useQuery({
    queryKey: ['admin', 'drivers', ''],
    queryFn: () => bff<DriverOption[]>('/v1/admin/drivers'),
    enabled: !canSeeMoney && canRecord,
  });
  const settlements = useQuery({
    queryKey: [...FIN, 'settlements'],
    queryFn: () => bff<SettlementItem[]>('/v1/admin/finance/settlements'),
  });
  const shortages = useQuery({
    queryKey: [...FIN, 'driver-shortages'],
    queryFn: () => bff<DriverShortageItem[]>('/v1/admin/finance/driver-shortages'),
    enabled: canSeeMoney,
  });
  const people = canSeeMoney
    ? (drivers.data?.map((row) => row.driver) ?? [])
    : (driverOptions.data ?? []);
  const record = useBffPost('/v1/admin/finance/settlements');
  const propose = useBffPost('/v1/admin/finance/driver-shortages', false);
  const repay = useBffPost('/v1/admin/finance/driver-repayments');
  const recordError = useFieldError(record.error);
  const proposeError = useFieldError(propose.error);
  const repayError = useFieldError(repay.error);

  const driverSelect = (
    <NativeSelect name="driverId" defaultValue="" aria-label={t('finance.driver')}>
      <option value="" disabled>
        {t('finance.chooseDriver')}
      </option>
      {people.map((driver) => (
        <option key={driver.id} value={driver.id}>
          {driver.fullName}
        </option>
      ))}
    </NativeSelect>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-6">
        {canSeeMoney ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('finance.tabs.drivers')}</CardTitle>
            </CardHeader>
            <CardContent>
              {drivers.isError ? <ErrorAlert error={drivers.error} /> : null}
              <table className="w-full text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 text-start font-medium">{t('finance.driver')}</th>
                    <th className="py-1 text-start font-medium">{t('finance.custody')}</th>
                    <th className="py-1 text-start font-medium">{t('finance.receivable')}</th>
                    <th className="py-1 text-start font-medium">
                      {t('finance.pendingSettlement')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {drivers.data?.map((row) => (
                    <tr key={row.driver.id}>
                      <td className="py-1.5">{row.driver.fullName}</td>
                      <td>
                        <Amount value={row.custody} />
                      </td>
                      <td>
                        <Amount value={row.receivable} />
                      </td>
                      <td>
                        <Amount value={row.pendingSettlement} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{t('finance.settlements')}</CardTitle>
            <CardDescription>{t('finance.countedHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            {settlements.data?.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('finance.empty')}</p>
            ) : null}
            <ul className="divide-y">
              {settlements.data?.map((settlement) => (
                <SettlementRow
                  key={settlement.id}
                  settlement={settlement}
                  canCount={canCount}
                  userId={userId}
                />
              ))}
            </ul>
          </CardContent>
        </Card>

        {canSeeMoney ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('finance.shortages')}</CardTitle>
            </CardHeader>
            <CardContent>
              {shortages.data?.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('finance.empty')}</p>
              ) : null}
              <ul className="divide-y">
                {shortages.data?.map((shortage) => (
                  <li key={shortage.id} className="flex flex-col gap-2 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {shortage.driver.fullName} · <Amount value={shortage.amount} /> ·{' '}
                        {t(`finance.responsibility.${shortage.responsibility}`)}
                      </span>
                      <StatusPill
                        tone={
                          shortage.status === 'PENDING_APPROVAL'
                            ? 'warn'
                            : shortage.status === 'APPLIED'
                              ? 'ok'
                              : 'muted'
                        }
                      >
                        {t(`finance.approvalStatus.${shortage.status}`)}
                      </StatusPill>
                    </div>
                    <p className="text-muted-foreground">
                      {shortage.reason} ·{' '}
                      {t('finance.proposedBy', { name: shortage.proposedBy.fullName })} ·{' '}
                      {formatDateTime(shortage.createdAt, i18n.language)}
                    </p>
                    {canManage && shortage.status === 'PENDING_APPROVAL' ? (
                      <DecisionButtons path={`/v1/admin/finance/driver-shortages/${shortage.id}`} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {canRecord || canCount ? (
        <div className="flex flex-col gap-3">
          {canRecord ? (
            <InlineAction
              label={t('finance.recordSettlement')}
              successMessage={t('finance.settlementRecorded')}
              pending={record.isPending}
              error={record.error}
              onSubmit={(form) =>
                record.mutateAsync({
                  driverId: text(form, 'driverId'),
                  declaredAmount: text(form, 'amount'),
                  note: optional(form, 'note'),
                })
              }
            >
              {driverSelect}
              {recordError('driverId')}
              <FormField
                name="amount"
                dir="ltr"
                inputMode="decimal"
                label={t('finance.declared')}
              />
              {recordError('declaredAmount')}
              <FormField name="note" label={t('finance.note')} />
            </InlineAction>
          ) : null}
          {canCount ? (
            <InlineAction
              label={t('finance.proposeShortage')}
              pending={propose.isPending}
              error={propose.error}
              onSubmit={(form) =>
                propose.mutateAsync({
                  driverId: text(form, 'driverId'),
                  amount: text(form, 'amount'),
                  responsibility: text(form, 'responsibility'),
                  reason: text(form, 'reason'),
                })
              }
            >
              {driverSelect}
              <FormField name="amount" dir="ltr" inputMode="decimal" label={t('finance.amount')} />
              {proposeError('amount')}
              <NativeSelect
                name="responsibility"
                defaultValue="DRIVER_LIABLE"
                aria-label={t('finance.whoBears')}
              >
                <option value="DRIVER_LIABLE">{t('finance.responsibility.DRIVER_LIABLE')}</option>
                <option value="COMPANY_ABSORBS">
                  {t('finance.responsibility.COMPANY_ABSORBS')}
                </option>
              </NativeSelect>
              <FormField name="reason" label={t('finance.reason')} />
              {proposeError('reason')}
            </InlineAction>
          ) : null}
          {/* Receiving and posting a driver's debt repayment is the accountant's job. */}
          {canCount ? (
            <InlineAction
              label={t('finance.repayment')}
              pending={repay.isPending}
              error={repay.error}
              onSubmit={(form) =>
                repay.mutateAsync({
                  driverId: text(form, 'driverId'),
                  amount: text(form, 'amount'),
                  channel: text(form, 'channel'),
                  note: optional(form, 'note'),
                })
              }
            >
              {driverSelect}
              <FormField name="amount" dir="ltr" inputMode="decimal" label={t('finance.amount')} />
              {repayError('amount')}
              <FormField
                name="receiptReference"
                dir="ltr"
                label={t('finance.receiptReference')}
                hint={t('finance.receiptReferenceHint')}
              />
              {repayError('receiptReference')}
              <ChannelSelect label={t('finance.channel')} />
              <FormField name="note" label={t('finance.note')} />
            </InlineAction>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SettlementRow({
  settlement,
  canCount,
  userId,
}: {
  settlement: SettlementItem;
  canCount: boolean;
  userId: string;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useBffPost(`/v1/admin/finance/settlements/${settlement.id}/confirm`);
  const reject = useBffPost(`/v1/admin/finance/settlements/${settlement.id}/reject`, false);
  const fieldError = useFieldError(confirm.error);
  const registeredByMe = settlement.submittedBy.id === userId;
  return (
    <li className="flex flex-col gap-2 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {settlement.driver.fullName} · {t('finance.declared')}{' '}
          <Amount value={settlement.declaredAmount} />
          {settlement.countedAmount ? (
            <>
              {' · '}
              {t('finance.counted')} <Amount value={settlement.countedAmount} />
            </>
          ) : null}
          {settlement.discrepancy && settlement.discrepancy !== '0.00' ? (
            <>
              {' · '}
              {t('finance.discrepancy')} <Amount value={settlement.discrepancy} />
            </>
          ) : null}
        </span>
        <StatusPill
          tone={
            settlement.status === 'SUBMITTED'
              ? 'warn'
              : settlement.status === 'CONFIRMED'
                ? 'ok'
                : 'muted'
          }
        >
          {t(`finance.settlementStatus.${settlement.status}`)}
        </StatusPill>
      </div>
      <p className="text-muted-foreground">
        {formatDateTime(settlement.createdAt, i18n.language)} ·{' '}
        {t('finance.requestedBy', { name: settlement.submittedBy.fullName })}
        {settlement.decidedBy
          ? ` · ${t('finance.decidedBy', { name: settlement.decidedBy.fullName })}`
          : ''}
        {settlement.decisionNote ? ` · ${settlement.decisionNote}` : ''}
      </p>
      {canCount && settlement.status === 'SUBMITTED' && registeredByMe ? (
        <p className="text-muted-foreground">{t('finance.countByAnotherAccountant')}</p>
      ) : null}
      {canCount && settlement.status === 'SUBMITTED' && !registeredByMe ? (
        <div className="flex flex-wrap gap-2">
          <InlineAction
            label={t('finance.confirm')}
            variant="default"
            pending={confirm.isPending}
            error={confirm.error}
            onSubmit={(form) =>
              confirm.mutateAsync({
                countedAmount: text(form, 'counted'),
                channel: text(form, 'channel'),
                note: optional(form, 'note'),
              })
            }
          >
            <FormField
              name="counted"
              dir="ltr"
              inputMode="decimal"
              label={t('finance.counted')}
              defaultValue={settlement.declaredAmount}
            />
            {fieldError('countedAmount')}
            <ChannelSelect label={t('finance.channel')} />
            <FormField name="note" label={t('finance.note')} />
          </InlineAction>
          <InlineAction
            label={t('finance.reject')}
            variant="destructive"
            pending={reject.isPending}
            error={reject.error}
            onSubmit={(form) => reject.mutateAsync({ note: text(form, 'note') })}
          >
            <FormField name="note" label={t('finance.reason')} />
          </InlineAction>
        </div>
      ) : null}
    </li>
  );
}

/** Approve / reject buttons for an item that needs a second person's decision. */
function DecisionButtons({ path }: { path: string }) {
  const { t } = useTranslation();
  const approve = useBffPost(`${path}/approve`);
  const reject = useBffPost(`${path}/reject`);
  return (
    <div className="flex flex-wrap gap-2">
      <InlineAction
        label={t('finance.approve')}
        variant="default"
        pending={approve.isPending}
        error={approve.error}
        onSubmit={(form) => approve.mutateAsync({ note: optional(form, 'note') })}
      >
        <FormField name="note" label={t('finance.note')} />
      </InlineAction>
      <InlineAction
        label={t('finance.reject')}
        variant="destructive"
        pending={reject.isPending}
        error={reject.error}
        onSubmit={(form) => reject.mutateAsync({ note: text(form, 'note') })}
      >
        <FormField name="note" label={t('finance.reason')} />
      </InlineAction>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Merchant balances and payouts
// ---------------------------------------------------------------------------

function MerchantsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const merchants = useQuery({
    queryKey: [...FIN, 'merchants'],
    queryFn: () => bff<MerchantBalanceRow[]>('/v1/admin/finance/merchants'),
  });
  const payouts = useQuery({
    queryKey: [...FIN, 'payouts'],
    queryFn: () => bff<PayoutItem[]>('/v1/admin/finance/payouts'),
  });
  const create = useBffPost('/v1/admin/finance/payouts');
  const payment = useBffPost('/v1/admin/finance/merchant-payments');
  const transfer = useBffPost('/v1/admin/finance/treasury-transfers');
  const createError = useFieldError(create.error);
  const transferError = useFieldError(transfer.error);

  const merchantSelect = (
    <NativeSelect name="merchantId" defaultValue="" aria-label={t('finance.merchant')}>
      <option value="" disabled>
        {t('finance.chooseMerchant')}
      </option>
      {merchants.data?.map((row) => (
        <option key={row.merchant.id} value={row.merchant.id}>
          {row.merchant.businessName}
        </option>
      ))}
    </NativeSelect>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('finance.tabs.merchants')}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {merchants.isError ? <ErrorAlert error={merchants.error} /> : null}
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-start font-medium">{t('finance.merchant')}</th>
                  <th className="py-1 text-start font-medium">{t('finance.pendingCod')}</th>
                  <th className="py-1 text-start font-medium">{t('finance.balance')}</th>
                  <th className="py-1 text-start font-medium">{t('finance.reserved')}</th>
                  <th className="py-1 text-start font-medium">{t('finance.available')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {merchants.data?.map((row) => (
                  <tr key={row.merchant.id}>
                    <td className="py-1.5">{row.merchant.businessName}</td>
                    <td>
                      <Amount value={row.pending} />
                    </td>
                    <td>
                      <Amount value={row.balance} />
                    </td>
                    <td>
                      <Amount value={row.reserved} />
                    </td>
                    <td className="font-semibold">
                      <Amount value={row.available} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('finance.payouts')}</CardTitle>
          </CardHeader>
          <CardContent>
            {payouts.data?.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('finance.empty')}</p>
            ) : null}
            <ul className="divide-y">
              {payouts.data?.map((payout) => (
                <PayoutRow key={payout.id} payout={payout} canManage={canManage} />
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      {canManage ? (
        <div className="flex flex-col gap-3">
          <InlineAction
            label={t('finance.createPayout')}
            variant="default"
            pending={create.isPending}
            error={create.error}
            onSubmit={(form) =>
              create.mutateAsync({
                merchantId: text(form, 'merchantId'),
                amount: text(form, 'amount'),
                method: text(form, 'method'),
                note: optional(form, 'note'),
              })
            }
          >
            {merchantSelect}
            {createError('merchantId')}
            <FormField name="amount" dir="ltr" inputMode="decimal" label={t('finance.amount')} />
            {createError('amount')}
            <NativeSelect name="method" defaultValue="CASH" aria-label={t('finance.method')}>
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`finance.methods.${method}`)}
                </option>
              ))}
            </NativeSelect>
            <FormField name="note" label={t('finance.note')} />
          </InlineAction>
          <InlineAction
            label={t('finance.merchantPayment')}
            pending={payment.isPending}
            error={payment.error}
            onSubmit={(form) =>
              payment.mutateAsync({
                merchantId: text(form, 'merchantId'),
                amount: text(form, 'amount'),
                channel: text(form, 'channel'),
                reference: optional(form, 'reference'),
              })
            }
          >
            {merchantSelect}
            <FormField name="amount" dir="ltr" inputMode="decimal" label={t('finance.amount')} />
            <ChannelSelect label={t('finance.channel')} />
            <FormField name="reference" dir="ltr" label={t('finance.reference')} />
          </InlineAction>
          <InlineAction
            label={t('finance.transfer')}
            pending={transfer.isPending}
            error={transfer.error}
            onSubmit={(form) =>
              transfer.mutateAsync({
                fromChannel: text(form, 'from'),
                toChannel: text(form, 'to'),
                amount: text(form, 'amount'),
                reference: optional(form, 'reference'),
              })
            }
          >
            <ChannelSelect name="from" label={t('finance.fromChannel')} />
            <ChannelSelect name="to" label={t('finance.toChannel')} />
            {transferError('toChannel')}
            <FormField name="amount" dir="ltr" inputMode="decimal" label={t('finance.amount')} />
            {transferError('amount')}
            <FormField name="reference" dir="ltr" label={t('finance.reference')} />
          </InlineAction>
        </div>
      ) : null}
    </div>
  );
}

function PayoutRow({ payout, canManage }: { payout: PayoutItem; canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const approve = useBffPost(`/v1/admin/finance/payouts/${payout.id}/approve`);
  const pay = useBffPost(`/v1/admin/finance/payouts/${payout.id}/pay`);
  const cancel = useBffPost(`/v1/admin/finance/payouts/${payout.id}/cancel`, false);
  const payError = useFieldError(pay.error);
  const tone = payout.status === 'PAID' ? 'ok' : payout.status === 'CANCELLED' ? 'muted' : 'warn';
  return (
    <li className="flex flex-col gap-2 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {payout.merchant.businessName} · <Amount value={payout.amount} /> ·{' '}
          {t(`finance.methods.${payout.method}`)}
        </span>
        <StatusPill tone={tone}>{t(`finance.payoutStatus.${payout.status}`)}</StatusPill>
      </div>
      <p className="text-muted-foreground">
        {formatDateTime(payout.createdAt, i18n.language)} ·{' '}
        {payout.requestedByMerchant
          ? t('finance.requestedByMerchant')
          : t('finance.requestedBy', { name: payout.createdBy.fullName })}
        {payout.approvedBy
          ? ` · ${t('finance.decidedBy', { name: payout.approvedBy.fullName })}`
          : ''}
        {payout.reference ? ` · ${payout.reference}` : ''}
        {payout.cancelReason ? ` · ${payout.cancelReason}` : ''}
      </p>
      {canManage && (payout.status === 'PENDING_APPROVAL' || payout.status === 'APPROVED') ? (
        <div className="flex flex-wrap gap-2">
          {payout.status === 'PENDING_APPROVAL' ? (
            <InlineAction
              label={t('finance.approve')}
              variant="default"
              pending={approve.isPending}
              error={approve.error}
              onSubmit={() => approve.mutateAsync({})}
            />
          ) : (
            <InlineAction
              label={t('finance.pay')}
              variant="default"
              pending={pay.isPending}
              error={pay.error}
              onSubmit={(form) =>
                pay.mutateAsync({
                  reference: text(form, 'reference'),
                  note: optional(form, 'note'),
                })
              }
            >
              <FormField name="reference" dir="ltr" label={t('finance.reference')} />
              {payError('reference')}
              <FormField name="note" label={t('finance.note')} />
            </InlineAction>
          )}
          <InlineAction
            label={t('finance.cancel')}
            variant="destructive"
            pending={cancel.isPending}
            error={cancel.error}
            onSubmit={(form) => cancel.mutateAsync({ note: text(form, 'note') })}
          >
            <FormField name="note" label={t('finance.reason')} />
          </InlineAction>
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Reviews: recipient shortfalls, adjustments, fee corrections
// ---------------------------------------------------------------------------

interface FeeCorrection {
  id: string;
  shipment: { id: string; trackingNumber: string };
  previousFee: string | null;
  newFee: string;
  reason: string;
  requestedBy: { id: string; fullName: string };
  createdAt: string;
}

function ReviewsTab({
  canDecide,
  canPropose,
  canSeeMoney,
}: {
  canDecide: boolean;
  canPropose: boolean;
  canSeeMoney: boolean;
}) {
  const { t, i18n } = useTranslation();
  const shortfalls = useQuery({
    queryKey: [...FIN, 'shortfalls'],
    queryFn: () => bff<CodShortfallItem[]>('/v1/admin/finance/shortfalls'),
  });
  const adjustments = useQuery({
    queryKey: [...FIN, 'adjustments'],
    queryFn: () => bff<AdjustmentItem[]>('/v1/admin/finance/adjustments'),
    enabled: canSeeMoney,
  });
  const corrections = useQuery({
    queryKey: [...FIN, 'fee-corrections'],
    queryFn: () => bff<FeeCorrection[]>('/v1/admin/finance/fee-corrections'),
    enabled: canSeeMoney,
  });
  const merchants = useQuery({
    queryKey: [...FIN, 'merchants'],
    queryFn: () => bff<MerchantBalanceRow[]>('/v1/admin/finance/merchants'),
    enabled: canDecide,
  });
  const requestAdjustment = useBffPost('/v1/admin/finance/adjustments', false);
  const adjustmentError = useFieldError(requestAdjustment.error);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('finance.shortfalls')}</CardTitle>
        </CardHeader>
        <CardContent>
          {shortfalls.isError ? <ErrorAlert error={shortfalls.error} /> : null}
          {shortfalls.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('finance.empty')}</p>
          ) : null}
          <ul className="divide-y">
            {shortfalls.data?.map((item) => (
              <ShortfallRow
                key={item.id}
                item={item}
                canDecide={canDecide}
                canPropose={canPropose}
              />
            ))}
          </ul>
        </CardContent>
      </Card>

      {canSeeMoney ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('finance.adjustments')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {canDecide ? (
                <InlineAction
                  label={t('finance.requestAdjustment')}
                  pending={requestAdjustment.isPending}
                  error={requestAdjustment.error}
                  onSubmit={(form) =>
                    requestAdjustment.mutateAsync({
                      type: text(form, 'type'),
                      merchantId: text(form, 'merchantId'),
                      amount: text(form, 'amount'),
                      reason: text(form, 'reason'),
                    })
                  }
                >
                  <NativeSelect
                    name="merchantId"
                    defaultValue=""
                    aria-label={t('finance.merchant')}
                  >
                    <option value="" disabled>
                      {t('finance.chooseMerchant')}
                    </option>
                    {merchants.data?.map((row) => (
                      <option key={row.merchant.id} value={row.merchant.id}>
                        {row.merchant.businessName}
                      </option>
                    ))}
                  </NativeSelect>
                  {adjustmentError('merchantId')}
                  <NativeSelect
                    name="type"
                    defaultValue="MERCHANT_CREDIT"
                    aria-label={t('finance.adjustments')}
                  >
                    <option value="MERCHANT_CREDIT">
                      {t('finance.adjustmentType.MERCHANT_CREDIT')}
                    </option>
                    <option value="MERCHANT_DEBIT">
                      {t('finance.adjustmentType.MERCHANT_DEBIT')}
                    </option>
                  </NativeSelect>
                  <FormField
                    name="amount"
                    dir="ltr"
                    inputMode="decimal"
                    label={t('finance.amount')}
                  />
                  {adjustmentError('amount')}
                  <FormField name="reason" label={t('finance.reason')} />
                  {adjustmentError('reason')}
                </InlineAction>
              ) : null}
              <ul className="divide-y">
                {adjustments.data?.map((item) => (
                  <li key={item.id} className="flex flex-col gap-2 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {item.merchant.businessName} · {t(`finance.adjustmentType.${item.type}`)} ·{' '}
                        <Amount value={item.amount} />
                      </span>
                      <StatusPill
                        tone={
                          item.status === 'PENDING_APPROVAL'
                            ? 'warn'
                            : item.status === 'APPLIED'
                              ? 'ok'
                              : 'muted'
                        }
                      >
                        {t(`finance.approvalStatus.${item.status}`)}
                      </StatusPill>
                    </div>
                    <p className="text-muted-foreground">
                      {item.reason} ·{' '}
                      {t('finance.requestedBy', { name: item.requestedBy.fullName })} ·{' '}
                      {formatDateTime(item.createdAt, i18n.language)}
                    </p>
                    {canDecide && item.status === 'PENDING_APPROVAL' ? (
                      <DecisionButtons path={`/v1/admin/finance/adjustments/${item.id}`} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('finance.feeCorrections')}</CardTitle>
            </CardHeader>
            <CardContent>
              {corrections.data?.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('finance.empty')}</p>
              ) : null}
              <ul className="divide-y">
                {corrections.data?.map((item) => (
                  <li key={item.id} className="flex flex-col gap-2 py-3 text-sm">
                    <span className="font-medium">
                      <Link
                        className="font-mono text-primary"
                        dir="ltr"
                        href={`/shipments/${item.shipment.id}`}
                      >
                        {item.shipment.trackingNumber}
                      </Link>{' '}
                      · <Amount value={item.previousFee} /> → <Amount value={item.newFee} />
                    </span>
                    <p className="text-muted-foreground">
                      {item.reason} ·{' '}
                      {t('finance.requestedBy', { name: item.requestedBy.fullName })}
                    </p>
                    {canDecide ? (
                      <DecisionButtons path={`/v1/admin/finance/fee-corrections/${item.id}`} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function ShortfallRow({
  item,
  canDecide,
  canPropose,
}: {
  item: CodShortfallItem;
  canDecide: boolean;
  canPropose: boolean;
}) {
  const { t, i18n } = useTranslation();
  const propose = useBffPost(`/v1/admin/finance/shortfalls/${item.id}/propose`, false);
  const proposeError = useFieldError(propose.error);
  const tone = item.status === 'RESOLVED' ? 'ok' : item.status === 'OPEN' ? 'bad' : 'warn';
  return (
    <li className="flex flex-col gap-2 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          <Link
            className="font-mono text-primary"
            dir="ltr"
            href={`/shipments/${item.shipment.id}`}
          >
            {item.shipment.trackingNumber}
          </Link>{' '}
          · {item.merchant.businessName} · {item.driver.fullName}
        </span>
        <StatusPill tone={tone}>
          {t(`finance.shortfallStatus.${item.status}`)}
          {item.resolution ? ` · ${t(`finance.resolution.${item.resolution}`)}` : ''}
        </StatusPill>
      </div>
      <p>
        {t('finance.expected')} <Amount value={item.expectedAmount} /> · {t('finance.collected')}{' '}
        <Amount value={item.collectedAmount} /> · {t('finance.outstanding')}{' '}
        <Amount value={item.outstandingAmount} className="font-semibold" />
      </p>
      <p className="text-muted-foreground">
        {item.reason} · {formatDateTime(item.createdAt, i18n.language)}
        {item.proposedResolution
          ? ` · ${t(`finance.resolution.${item.proposedResolution}`)} — ${t('finance.proposedBy', { name: item.proposedBy?.fullName ?? '' })}: ${item.proposalNote ?? ''}`
          : ''}
        {item.decisionNote ? ` · ${item.decisionNote}` : ''}
      </p>
      {canPropose && item.status === 'OPEN' ? (
        <InlineAction
          label={t('finance.propose')}
          pending={propose.isPending}
          error={propose.error}
          onSubmit={(form) =>
            propose.mutateAsync({ resolution: text(form, 'resolution'), note: text(form, 'note') })
          }
        >
          <NativeSelect
            name="resolution"
            defaultValue="COMPANY_ABSORBS"
            aria-label={t('finance.shortfallResolution')}
          >
            {PROPOSABLE_SHORTFALL_RESOLUTIONS.map((resolution) => (
              <option key={resolution} value={resolution}>
                {t(`finance.resolution.${resolution}`)}
              </option>
            ))}
          </NativeSelect>
          <FormField name="note" label={t('finance.reason')} />
          {proposeError('note')}
        </InlineAction>
      ) : null}
      {canDecide && item.status === 'PENDING_APPROVAL' ? (
        <DecisionButtons path={`/v1/admin/finance/shortfalls/${item.id}`} />
      ) : null}
      {item.status === 'AWAITING_MERCHANT' ? (
        <Alert>{t('finance.shortfallStatus.AWAITING_MERCHANT')}</Alert>
      ) : null}
    </li>
  );
}
